//! dmabuf 推流的 GPU 部分：EGL（GBM 平台）+ GLES2，建在合成器的主显示设备上（[`super::device`]）。
//!
//! - 导入：CEF 交来的 dmabuf（`OnAcceleratedPaint`，只在回调内有效）经 `EGL_EXT_image_dma_buf_import_modifiers` 包成
//!   `EGLImage` → `GL_TEXTURE_EXTERNAL_OES` 纹理，每帧导入一次、用完即弃。
//! - 输出到 dmabuf：按协商出的 modifier 用 GBM 分配缓冲，包成 `EGLImage` → renderbuffer → FBO，画一个全屏四边形拷过去。
//! - 输出到共享内存：画进一个 RGBA8 的 FBO（片元里交换 r / b），`glReadPixels` 读进 memfd 映射，内存里就是 BGRA。
//! - 每次拷完 `glFinish`：CEF 在回调返回后会重用它的缓冲，消费者拿到缓冲时内容也必须已经写完。
//!
//! 三个库都在运行时 `dlopen` 系统的（`libEGL.so.1`、`libGLESv2.so.2`、`libgbm.so.1`），不在编译期链接：一是装不上时整个
//! dmabuf 路径退回共享内存，不影响启动；二是 CEF 151 之前在 exe 旁带 ANGLE 的 `libEGL.so` / `libGLESv2.so`（之后静态
//! 链进 libcef），链接期依赖容易和它混。
//!
//! GL 上下文全进程一个，所有调用都持锁、调用前设为当前、调用后还原调用线程原来的当前上下文：帧回调在 CEF UI 线程，
//! 建删缓冲在 PipeWire 的线程，同一时刻只能有一个线程持有它。

use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::os::fd::{FromRawFd, OwnedFd};
use std::sync::{Mutex, MutexGuard, OnceLock};

use libloading::Library;
use tauri_runtime_kbcef::{DmaBufPlane, OffscreenPixelFormat};

// ---- 类型与常量（数值取自 Khronos 的 egl.h / eglext.h / gl2.h / gl2ext.h 与 drm_fourcc.h）----

type EglDisplay = *mut c_void;
type EglContext = *mut c_void;
type EglSurface = *mut c_void;
type EglImage = *mut c_void;
type EglConfig = *mut c_void;
type EglBoolean = c_uint;
type EglInt = i32;
type EglEnum = c_uint;
type GlUint = c_uint;
type GlInt = c_int;
type GlEnum = c_uint;

const EGL_NONE: EglInt = 0x3038;
const EGL_EXTENSIONS: EglInt = 0x3055;
const EGL_DRAW: EglInt = 0x3059;
const EGL_READ: EglInt = 0x305A;
const EGL_WIDTH: EglInt = 0x3057;
const EGL_HEIGHT: EglInt = 0x3056;
const EGL_OPENGL_ES_API: EglEnum = 0x30A0;
const EGL_CONTEXT_CLIENT_VERSION: EglInt = 0x3098;
const EGL_PLATFORM_GBM_KHR: EglEnum = 0x31D7;
const EGL_LINUX_DMA_BUF_EXT: EglEnum = 0x3270;
const EGL_LINUX_DRM_FOURCC_EXT: EglInt = 0x3271;
const EGL_PLANE_FD: [EglInt; 4] = [0x3272, 0x3275, 0x3278, 0x3440];
const EGL_PLANE_OFFSET: [EglInt; 4] = [0x3273, 0x3276, 0x3279, 0x3441];
const EGL_PLANE_PITCH: [EglInt; 4] = [0x3274, 0x3277, 0x327A, 0x3442];
const EGL_PLANE_MODIFIER_LO: [EglInt; 4] = [0x3443, 0x3445, 0x3447, 0x3449];
const EGL_PLANE_MODIFIER_HI: [EglInt; 4] = [0x3444, 0x3446, 0x3448, 0x344A];

const GL_TEXTURE_EXTERNAL_OES: GlEnum = 0x8D65;
const GL_TEXTURE_MIN_FILTER: GlEnum = 0x2801;
const GL_TEXTURE_MAG_FILTER: GlEnum = 0x2800;
const GL_TEXTURE_WRAP_S: GlEnum = 0x2802;
const GL_TEXTURE_WRAP_T: GlEnum = 0x2803;
const GL_NEAREST: GlInt = 0x2600;
const GL_CLAMP_TO_EDGE: GlInt = 0x812F;
const GL_TEXTURE0: GlEnum = 0x84C0;
const GL_FRAMEBUFFER: GlEnum = 0x8D40;
const GL_RENDERBUFFER: GlEnum = 0x8D41;
const GL_COLOR_ATTACHMENT0: GlEnum = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: GlEnum = 0x8CD5;
const GL_RGBA8_OES: GlEnum = 0x8058;
const GL_VERTEX_SHADER: GlEnum = 0x8B31;
const GL_FRAGMENT_SHADER: GlEnum = 0x8B30;
const GL_COMPILE_STATUS: GlEnum = 0x8B81;
const GL_LINK_STATUS: GlEnum = 0x8B82;
const GL_FLOAT: GlEnum = 0x1406;
const GL_TRIANGLE_STRIP: GlEnum = 0x0005;
const GL_RGBA: GlEnum = 0x1908;
const GL_UNSIGNED_BYTE: GlEnum = 0x1401;
const GL_PACK_ALIGNMENT: GlEnum = 0x0D05;
const GL_ARRAY_BUFFER: GlEnum = 0x8892;
const GL_BLEND: GlEnum = 0x0BE2;
const GL_SCISSOR_TEST: GlEnum = 0x0C11;
const GL_RENDERER: GlEnum = 0x1F01;
const GL_NO_ERROR: GlEnum = 0;

/// DRM `ARGB8888`（内存里 B、G、R、A）。
pub const DRM_FORMAT_ARGB8888: u32 = 0x3432_5241;
/// DRM `ABGR8888`（内存里 R、G、B、A）。
const DRM_FORMAT_ABGR8888: u32 = 0x3432_4241;
/// 隐式 modifier（由驱动决定，不随缓冲传递）。
const DRM_FORMAT_MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;
const GBM_BO_USE_RENDERING: u32 = 1 << 2;

/// 全屏四边形（三角形带）。
static QUAD: [f32; 8] = [-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0];

const VERTEX_SHADER: &str = "\
attribute vec2 a_pos;
uniform highp vec4 u_rect;
varying highp vec2 v_uv;
void main() {
    v_uv = u_rect.xy + (a_pos * 0.5 + 0.5) * u_rect.zw;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
";

// 纹理坐标必须是 highp：mediump 只有约 11 位尾数，4K 宽的纹理上 nearest 采样会取错像素
const FRAGMENT_SHADER: &str = "\
#extension GL_OES_EGL_image_external : require
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform samplerExternalOES u_tex;
uniform float u_swap;
varying highp vec2 v_uv;
void main() {
    vec4 c = texture2D(u_tex, v_uv);
    gl_FragColor = mix(c, c.bgra, u_swap);
}
";

// ---- 函数表 ----

type GetProcAddress = unsafe extern "C" fn(*const c_char) -> *mut c_void;

struct Egl {
    initialize: unsafe extern "C" fn(EglDisplay, *mut EglInt, *mut EglInt) -> EglBoolean,
    bind_api: unsafe extern "C" fn(EglEnum) -> EglBoolean,
    query_api: unsafe extern "C" fn() -> EglEnum,
    create_context: unsafe extern "C" fn(EglDisplay, EglConfig, EglContext, *const EglInt) -> EglContext,
    make_current: unsafe extern "C" fn(EglDisplay, EglSurface, EglSurface, EglContext) -> EglBoolean,
    get_current_context: unsafe extern "C" fn() -> EglContext,
    get_current_display: unsafe extern "C" fn() -> EglDisplay,
    get_current_surface: unsafe extern "C" fn(EglInt) -> EglSurface,
    get_error: unsafe extern "C" fn() -> EglInt,
    query_string: unsafe extern "C" fn(EglDisplay, EglInt) -> *const c_char,
    get_platform_display: unsafe extern "C" fn(EglEnum, *mut c_void, *const EglInt) -> EglDisplay,
    create_image: unsafe extern "C" fn(EglDisplay, EglContext, EglEnum, *mut c_void, *const EglInt) -> EglImage,
    destroy_image: unsafe extern "C" fn(EglDisplay, EglImage) -> EglBoolean,
    query_dmabuf_modifiers:
        unsafe extern "C" fn(EglDisplay, EglInt, EglInt, *mut u64, *mut EglBoolean, *mut EglInt) -> EglBoolean,
}

struct Gl {
    gen_textures: unsafe extern "C" fn(GlInt, *mut GlUint),
    delete_textures: unsafe extern "C" fn(GlInt, *const GlUint),
    bind_texture: unsafe extern "C" fn(GlEnum, GlUint),
    tex_parameteri: unsafe extern "C" fn(GlEnum, GlEnum, GlInt),
    active_texture: unsafe extern "C" fn(GlEnum),
    gen_framebuffers: unsafe extern "C" fn(GlInt, *mut GlUint),
    delete_framebuffers: unsafe extern "C" fn(GlInt, *const GlUint),
    bind_framebuffer: unsafe extern "C" fn(GlEnum, GlUint),
    framebuffer_renderbuffer: unsafe extern "C" fn(GlEnum, GlEnum, GlEnum, GlUint),
    check_framebuffer_status: unsafe extern "C" fn(GlEnum) -> GlEnum,
    gen_renderbuffers: unsafe extern "C" fn(GlInt, *mut GlUint),
    delete_renderbuffers: unsafe extern "C" fn(GlInt, *const GlUint),
    bind_renderbuffer: unsafe extern "C" fn(GlEnum, GlUint),
    renderbuffer_storage: unsafe extern "C" fn(GlEnum, GlEnum, GlInt, GlInt),
    viewport: unsafe extern "C" fn(GlInt, GlInt, GlInt, GlInt),
    disable: unsafe extern "C" fn(GlEnum),
    create_shader: unsafe extern "C" fn(GlEnum) -> GlUint,
    shader_source: unsafe extern "C" fn(GlUint, GlInt, *const *const c_char, *const GlInt),
    compile_shader: unsafe extern "C" fn(GlUint),
    get_shaderiv: unsafe extern "C" fn(GlUint, GlEnum, *mut GlInt),
    get_shader_info_log: unsafe extern "C" fn(GlUint, GlInt, *mut GlInt, *mut c_char),
    delete_shader: unsafe extern "C" fn(GlUint),
    create_program: unsafe extern "C" fn() -> GlUint,
    attach_shader: unsafe extern "C" fn(GlUint, GlUint),
    bind_attrib_location: unsafe extern "C" fn(GlUint, GlUint, *const c_char),
    link_program: unsafe extern "C" fn(GlUint),
    get_programiv: unsafe extern "C" fn(GlUint, GlEnum, *mut GlInt),
    get_program_info_log: unsafe extern "C" fn(GlUint, GlInt, *mut GlInt, *mut c_char),
    use_program: unsafe extern "C" fn(GlUint),
    get_uniform_location: unsafe extern "C" fn(GlUint, *const c_char) -> GlInt,
    uniform1i: unsafe extern "C" fn(GlInt, GlInt),
    uniform1f: unsafe extern "C" fn(GlInt, f32),
    uniform4f: unsafe extern "C" fn(GlInt, f32, f32, f32, f32),
    bind_buffer: unsafe extern "C" fn(GlEnum, GlUint),
    vertex_attrib_pointer: unsafe extern "C" fn(GlUint, GlInt, GlEnum, u8, GlInt, *const c_void),
    enable_vertex_attrib_array: unsafe extern "C" fn(GlUint),
    draw_arrays: unsafe extern "C" fn(GlEnum, GlInt, GlInt),
    finish: unsafe extern "C" fn(),
    read_pixels: unsafe extern "C" fn(GlInt, GlInt, GlInt, GlInt, GlEnum, GlEnum, *mut c_void),
    pixel_storei: unsafe extern "C" fn(GlEnum, GlInt),
    get_error: unsafe extern "C" fn() -> GlEnum,
    get_string: unsafe extern "C" fn(GlEnum) -> *const u8,
    image_target_texture_2d: unsafe extern "C" fn(GlEnum, EglImage),
    image_target_renderbuffer_storage: unsafe extern "C" fn(GlEnum, EglImage),
}

struct Gbm {
    create_device: unsafe extern "C" fn(c_int) -> *mut c_void,
    bo_create_with_modifiers2:
        unsafe extern "C" fn(*mut c_void, u32, u32, u32, *const u64, c_uint, u32) -> *mut c_void,
    bo_get_modifier: unsafe extern "C" fn(*mut c_void) -> u64,
    bo_get_plane_count: unsafe extern "C" fn(*mut c_void) -> c_int,
    bo_get_fd_for_plane: unsafe extern "C" fn(*mut c_void, c_int) -> c_int,
    bo_get_stride_for_plane: unsafe extern "C" fn(*mut c_void, c_int) -> u32,
    bo_get_offset: unsafe extern "C" fn(*mut c_void, c_int) -> u32,
    bo_destroy: unsafe extern "C" fn(*mut c_void),
}

/// 从库里取一个函数。`T` 是函数指针类型，由接收的字段推出来。
unsafe fn dlsym<T: Copy>(lib: &Library, name: &str) -> Result<T, String> {
    let cname = CString::new(name).map_err(|e| e.to_string())?;
    lib.get::<T>(cname.as_bytes_with_nul())
        .map(|symbol| *symbol)
        .map_err(|e| format!("{name}: {e}"))
}

/// 经 `eglGetProcAddress` 取扩展函数（GL 函数在 libGLESv2 里找不到时也走它）。
unsafe fn egl_proc<T: Copy>(get_proc_address: GetProcAddress, name: &str) -> Result<T, String> {
    let cname = CString::new(name).map_err(|e| e.to_string())?;
    let address = get_proc_address(cname.as_ptr());
    if address.is_null() {
        return Err(format!("{name} 不可用"));
    }
    Ok(std::mem::transmute_copy::<*mut c_void, T>(&address))
}

unsafe fn gl_fn<T: Copy>(lib: &Library, get_proc_address: GetProcAddress, name: &str) -> Result<T, String> {
    dlsym(lib, name).or_else(|_| egl_proc(get_proc_address, name))
}

// ---- 全局上下文 ----

struct State {
    egl: Egl,
    gl: Gl,
    gbm: Gbm,
    gbm_device: *mut c_void,
    display: EglDisplay,
    context: EglContext,
    /// 本设备能渲染进去的 `ARGB8888` modifier（不含只能当外部纹理的）
    modifiers: Vec<u64>,
    program: GlUint,
    u_tex: GlInt,
    u_rect: GlInt,
    u_swap: GlInt,
    /// 读回用的 RGBA8 FBO：(renderbuffer, fbo, 宽, 高)
    readback: Option<(GlUint, GlUint, u32, u32)>,
    _libs: [Library; 3],
    _drm: OwnedFd,
}

/// dmabuf 推流的 GPU 上下文，全进程一个。
pub struct Gpu {
    state: Mutex<State>,
    renderer: String,
}

// SAFETY: 裸指针（GBM 设备、EGL 显示 / 上下文）只在持锁时使用。
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

static GPU: OnceLock<Option<Gpu>> = OnceLock::new();

/// 全局 GPU 上下文；第一次调用时初始化，失败（不是 Wayland、库装不上、驱动不支持）返回 `None`、原因记一次日志。
pub fn get() -> Option<&'static Gpu> {
    GPU.get_or_init(|| match Gpu::init() {
        Ok(gpu) => {
            tracing::info!(
                "壁纸推流的 GPU 上下文就绪：{}，{} 个可渲染的 modifier",
                gpu.renderer,
                gpu.lock().modifiers.len()
            );
            Some(gpu)
        }
        Err(e) => {
            tracing::info!("壁纸推流不用 dmabuf（只用共享内存）：{e}");
            None
        }
    })
    .as_ref()
}

/// CEF 交来的一帧 dmabuf（只在帧回调内有效）。
pub struct DmaBufSource<'a> {
    pub planes: &'a [DmaBufPlane],
    pub modifier: u64,
    pub format: OffscreenPixelFormat,
    /// 缓冲尺寸（coded size）
    pub width: u32,
    pub height: u32,
    /// 有效内容（x, y, 宽, 高）
    pub visible: (i32, i32, u32, u32),
}

/// 一个 GBM 分配、导出给 PipeWire 的输出缓冲。随 PipeWire 的缓冲建删。
pub struct GpuTarget {
    gpu: &'static Gpu,
    bo: *mut c_void,
    image: EglImage,
    renderbuffer: GlUint,
    fbo: GlUint,
    pub width: u32,
    pub height: u32,
    pub planes: Vec<TargetPlane>,
}

// SAFETY: 裸指针只在持 GPU 锁时使用。
unsafe impl Send for GpuTarget {}

/// 输出缓冲的一个 plane（交给 PipeWire 的 `spa_data`）。
pub struct TargetPlane {
    pub fd: OwnedFd,
    pub stride: u32,
    pub offset: u32,
}

/// 持锁且本线程当前上下文是我们的；析构时还原调用线程原来的当前上下文与 API。
struct Current<'a> {
    state: MutexGuard<'a, State>,
    previous_api: EglEnum,
    previous: (EglDisplay, EglSurface, EglSurface, EglContext),
}

impl Drop for Current<'_> {
    fn drop(&mut self) {
        let egl = &self.state.egl;
        // SAFETY: 都是本线程的 EGL 状态。
        unsafe {
            let (display, draw, read, context) = self.previous;
            if context.is_null() {
                (egl.make_current)(self.state.display, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
            } else {
                (egl.make_current)(display, draw, read, context);
            }
            (egl.bind_api)(self.previous_api);
        }
    }
}

impl Gpu {
    fn init() -> Result<Gpu, String> {
        let node = super::device::render_node().ok_or("没有可用的 render node")?;
        // SAFETY: 载入系统库、按签名取符号；之后的 FFI 都按 Khronos / GBM 的约定调用。
        unsafe {
            let egl_lib = Library::new("libEGL.so.1").map_err(|e| format!("libEGL.so.1: {e}"))?;
            let gles_lib = Library::new("libGLESv2.so.2").map_err(|e| format!("libGLESv2.so.2: {e}"))?;
            let gbm_lib = Library::new("libgbm.so.1").map_err(|e| format!("libgbm.so.1: {e}"))?;
            let get_proc_address: GetProcAddress = dlsym(&egl_lib, "eglGetProcAddress")?;
            let egl = Egl {
                initialize: dlsym(&egl_lib, "eglInitialize")?,
                bind_api: dlsym(&egl_lib, "eglBindAPI")?,
                query_api: dlsym(&egl_lib, "eglQueryAPI")?,
                create_context: dlsym(&egl_lib, "eglCreateContext")?,
                make_current: dlsym(&egl_lib, "eglMakeCurrent")?,
                get_current_context: dlsym(&egl_lib, "eglGetCurrentContext")?,
                get_current_display: dlsym(&egl_lib, "eglGetCurrentDisplay")?,
                get_current_surface: dlsym(&egl_lib, "eglGetCurrentSurface")?,
                get_error: dlsym(&egl_lib, "eglGetError")?,
                query_string: dlsym(&egl_lib, "eglQueryString")?,
                get_platform_display: egl_proc(get_proc_address, "eglGetPlatformDisplayEXT")?,
                create_image: egl_proc(get_proc_address, "eglCreateImageKHR")?,
                destroy_image: egl_proc(get_proc_address, "eglDestroyImageKHR")?,
                query_dmabuf_modifiers: egl_proc(get_proc_address, "eglQueryDmaBufModifiersEXT")?,
            };
            let gl = Gl {
                gen_textures: gl_fn(&gles_lib, get_proc_address, "glGenTextures")?,
                delete_textures: gl_fn(&gles_lib, get_proc_address, "glDeleteTextures")?,
                bind_texture: gl_fn(&gles_lib, get_proc_address, "glBindTexture")?,
                tex_parameteri: gl_fn(&gles_lib, get_proc_address, "glTexParameteri")?,
                active_texture: gl_fn(&gles_lib, get_proc_address, "glActiveTexture")?,
                gen_framebuffers: gl_fn(&gles_lib, get_proc_address, "glGenFramebuffers")?,
                delete_framebuffers: gl_fn(&gles_lib, get_proc_address, "glDeleteFramebuffers")?,
                bind_framebuffer: gl_fn(&gles_lib, get_proc_address, "glBindFramebuffer")?,
                framebuffer_renderbuffer: gl_fn(&gles_lib, get_proc_address, "glFramebufferRenderbuffer")?,
                check_framebuffer_status: gl_fn(&gles_lib, get_proc_address, "glCheckFramebufferStatus")?,
                gen_renderbuffers: gl_fn(&gles_lib, get_proc_address, "glGenRenderbuffers")?,
                delete_renderbuffers: gl_fn(&gles_lib, get_proc_address, "glDeleteRenderbuffers")?,
                bind_renderbuffer: gl_fn(&gles_lib, get_proc_address, "glBindRenderbuffer")?,
                renderbuffer_storage: gl_fn(&gles_lib, get_proc_address, "glRenderbufferStorage")?,
                viewport: gl_fn(&gles_lib, get_proc_address, "glViewport")?,
                disable: gl_fn(&gles_lib, get_proc_address, "glDisable")?,
                create_shader: gl_fn(&gles_lib, get_proc_address, "glCreateShader")?,
                shader_source: gl_fn(&gles_lib, get_proc_address, "glShaderSource")?,
                compile_shader: gl_fn(&gles_lib, get_proc_address, "glCompileShader")?,
                get_shaderiv: gl_fn(&gles_lib, get_proc_address, "glGetShaderiv")?,
                get_shader_info_log: gl_fn(&gles_lib, get_proc_address, "glGetShaderInfoLog")?,
                delete_shader: gl_fn(&gles_lib, get_proc_address, "glDeleteShader")?,
                create_program: gl_fn(&gles_lib, get_proc_address, "glCreateProgram")?,
                attach_shader: gl_fn(&gles_lib, get_proc_address, "glAttachShader")?,
                bind_attrib_location: gl_fn(&gles_lib, get_proc_address, "glBindAttribLocation")?,
                link_program: gl_fn(&gles_lib, get_proc_address, "glLinkProgram")?,
                get_programiv: gl_fn(&gles_lib, get_proc_address, "glGetProgramiv")?,
                get_program_info_log: gl_fn(&gles_lib, get_proc_address, "glGetProgramInfoLog")?,
                use_program: gl_fn(&gles_lib, get_proc_address, "glUseProgram")?,
                get_uniform_location: gl_fn(&gles_lib, get_proc_address, "glGetUniformLocation")?,
                uniform1i: gl_fn(&gles_lib, get_proc_address, "glUniform1i")?,
                uniform1f: gl_fn(&gles_lib, get_proc_address, "glUniform1f")?,
                uniform4f: gl_fn(&gles_lib, get_proc_address, "glUniform4f")?,
                bind_buffer: gl_fn(&gles_lib, get_proc_address, "glBindBuffer")?,
                vertex_attrib_pointer: gl_fn(&gles_lib, get_proc_address, "glVertexAttribPointer")?,
                enable_vertex_attrib_array: gl_fn(&gles_lib, get_proc_address, "glEnableVertexAttribArray")?,
                draw_arrays: gl_fn(&gles_lib, get_proc_address, "glDrawArrays")?,
                finish: gl_fn(&gles_lib, get_proc_address, "glFinish")?,
                read_pixels: gl_fn(&gles_lib, get_proc_address, "glReadPixels")?,
                pixel_storei: gl_fn(&gles_lib, get_proc_address, "glPixelStorei")?,
                get_error: gl_fn(&gles_lib, get_proc_address, "glGetError")?,
                get_string: gl_fn(&gles_lib, get_proc_address, "glGetString")?,
                image_target_texture_2d: egl_proc(get_proc_address, "glEGLImageTargetTexture2DOES")?,
                image_target_renderbuffer_storage: egl_proc(
                    get_proc_address,
                    "glEGLImageTargetRenderbufferStorageOES",
                )?,
            };
            let gbm = Gbm {
                create_device: dlsym(&gbm_lib, "gbm_create_device")?,
                bo_create_with_modifiers2: dlsym(&gbm_lib, "gbm_bo_create_with_modifiers2")?,
                bo_get_modifier: dlsym(&gbm_lib, "gbm_bo_get_modifier")?,
                bo_get_plane_count: dlsym(&gbm_lib, "gbm_bo_get_plane_count")?,
                bo_get_fd_for_plane: dlsym(&gbm_lib, "gbm_bo_get_fd_for_plane")?,
                bo_get_stride_for_plane: dlsym(&gbm_lib, "gbm_bo_get_stride_for_plane")?,
                bo_get_offset: dlsym(&gbm_lib, "gbm_bo_get_offset")?,
                bo_destroy: dlsym(&gbm_lib, "gbm_bo_destroy")?,
            };

            let path = CString::new(node.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
            let fd = libc::open(path.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC);
            if fd < 0 {
                return Err(format!("打开 {} 失败: {}", node.display(), std::io::Error::last_os_error()));
            }
            let drm = OwnedFd::from_raw_fd(fd);
            let gbm_device = (gbm.create_device)(fd);
            if gbm_device.is_null() {
                return Err(format!("{} 上 gbm_create_device 失败", node.display()));
            }
            let display = (egl.get_platform_display)(EGL_PLATFORM_GBM_KHR, gbm_device, std::ptr::null());
            if display.is_null() {
                return Err("eglGetPlatformDisplayEXT(GBM) 失败".to_string());
            }
            let (mut major, mut minor) = (0, 0);
            if (egl.initialize)(display, &mut major, &mut minor) == 0 {
                return Err(format!("eglInitialize 失败 0x{:x}", (egl.get_error)()));
            }
            let extensions = cstr((egl.query_string)(display, EGL_EXTENSIONS));
            for required in [
                "EGL_EXT_image_dma_buf_import_modifiers",
                "EGL_KHR_surfaceless_context",
                "EGL_KHR_no_config_context",
            ] {
                if !extensions.split_ascii_whitespace().any(|ext| ext == required) {
                    return Err(format!("EGL 缺少 {required}"));
                }
            }

            let previous_api = (egl.query_api)();
            (egl.bind_api)(EGL_OPENGL_ES_API);
            let attributes = [EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE];
            let context = (egl.create_context)(display, std::ptr::null_mut(), std::ptr::null_mut(), attributes.as_ptr());
            (egl.bind_api)(previous_api);
            if context.is_null() {
                return Err(format!("eglCreateContext 失败 0x{:x}", (egl.get_error)()));
            }

            let modifiers = query_modifiers(&egl, display)?;
            if modifiers.is_empty() {
                return Err("设备没有可渲染的 ARGB8888 modifier".to_string());
            }

            let gpu = Gpu {
                state: Mutex::new(State {
                    egl,
                    gl,
                    gbm,
                    gbm_device,
                    display,
                    context,
                    modifiers,
                    program: 0,
                    u_tex: -1,
                    u_rect: -1,
                    u_swap: -1,
                    readback: None,
                    _libs: [egl_lib, gles_lib, gbm_lib],
                    _drm: drm,
                }),
                renderer: String::new(),
            };
            let renderer = {
                let mut current = gpu.current()?;
                let state = &mut *current.state;
                let renderer = cstr((state.gl.get_string)(GL_RENDERER).cast());
                let program = build_program(&state.gl)?;
                state.u_tex = uniform(&state.gl, program, "u_tex");
                state.u_rect = uniform(&state.gl, program, "u_rect");
                state.u_swap = uniform(&state.gl, program, "u_swap");
                state.program = program;
                format!("{renderer}（{}，EGL {major}.{minor}）", node.display())
            };
            Ok(Gpu { renderer, ..gpu })
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 持锁并把上下文设为本线程当前。
    fn current(&self) -> Result<Current<'_>, String> {
        let state = self.lock();
        let egl = &state.egl;
        // SAFETY: 本线程的 EGL 状态；上下文同一时刻只在持锁的线程上当前。
        unsafe {
            let previous_api = (egl.query_api)();
            (egl.bind_api)(EGL_OPENGL_ES_API);
            let previous = (
                (egl.get_current_display)(),
                (egl.get_current_surface)(EGL_DRAW),
                (egl.get_current_surface)(EGL_READ),
                (egl.get_current_context)(),
            );
            if (egl.make_current)(state.display, std::ptr::null_mut(), std::ptr::null_mut(), state.context) == 0 {
                let error = (egl.get_error)();
                (egl.bind_api)(previous_api);
                return Err(format!("eglMakeCurrent 失败 0x{error:x}"));
            }
            Ok(Current {
                state,
                previous_api,
                previous,
            })
        }
    }

    /// 本设备能渲染进去的 `ARGB8888` modifier。
    pub fn modifiers(&self) -> Vec<u64> {
        self.lock().modifiers.clone()
    }

    /// 在消费者接受的 modifier 里挑一个本设备分配得出来的（试分配一次）。
    pub fn choose_modifier(&self, width: u32, height: u32, candidates: &[u64]) -> Option<u64> {
        let state = self.lock();
        let candidates: Vec<u64> = candidates
            .iter()
            .copied()
            .filter(|modifier| *modifier != DRM_FORMAT_MOD_INVALID)
            .collect();
        if candidates.is_empty() {
            return None;
        }
        // SAFETY: GBM 设备有效；试分配的 bo 立刻销毁。
        unsafe {
            let bo = (state.gbm.bo_create_with_modifiers2)(
                state.gbm_device,
                width,
                height,
                DRM_FORMAT_ARGB8888,
                candidates.as_ptr(),
                candidates.len() as c_uint,
                GBM_BO_USE_RENDERING,
            );
            if bo.is_null() {
                return None;
            }
            let chosen = (state.gbm.bo_get_modifier)(bo);
            (state.gbm.bo_destroy)(bo);
            Some(chosen)
        }
    }

    /// 这个 modifier 的缓冲有几个 plane（PipeWire 的 `blocks`）。
    pub fn plane_count(&self, width: u32, height: u32, modifier: u64) -> Option<u32> {
        let state = self.lock();
        // SAFETY: 同上。
        unsafe {
            let bo = (state.gbm.bo_create_with_modifiers2)(
                state.gbm_device,
                width,
                height,
                DRM_FORMAT_ARGB8888,
                &modifier,
                1,
                GBM_BO_USE_RENDERING,
            );
            if bo.is_null() {
                return None;
            }
            let planes = (state.gbm.bo_get_plane_count)(bo).max(1) as u32;
            (state.gbm.bo_destroy)(bo);
            Some(planes)
        }
    }

    /// 分配一个输出缓冲并建好 FBO。
    pub fn alloc_target(&'static self, width: u32, height: u32, modifier: u64) -> Result<GpuTarget, String> {
        let current = self.current()?;
        let state = &*current.state;
        // SAFETY: 持锁、上下文当前；失败路径逐项释放已建的对象。
        unsafe {
            let bo = (state.gbm.bo_create_with_modifiers2)(
                state.gbm_device,
                width,
                height,
                DRM_FORMAT_ARGB8888,
                &modifier,
                1,
                GBM_BO_USE_RENDERING,
            );
            if bo.is_null() {
                return Err(format!("GBM 分配 {width}x{height} modifier 0x{modifier:x} 失败"));
            }
            let count = (state.gbm.bo_get_plane_count)(bo).clamp(1, 4);
            let mut planes = Vec::with_capacity(count as usize);
            for plane in 0..count {
                let fd = (state.gbm.bo_get_fd_for_plane)(bo, plane);
                if fd < 0 {
                    (state.gbm.bo_destroy)(bo);
                    return Err(format!("导出 plane {plane} 的 fd 失败"));
                }
                planes.push(TargetPlane {
                    fd: OwnedFd::from_raw_fd(fd),
                    stride: (state.gbm.bo_get_stride_for_plane)(bo, plane),
                    offset: (state.gbm.bo_get_offset)(bo, plane),
                });
            }
            let plane_refs: Vec<(c_int, u32, u32)> = planes
                .iter()
                .map(|plane| (std::os::fd::AsRawFd::as_raw_fd(&plane.fd), plane.offset, plane.stride))
                .collect();
            let image = create_image(state, width, height, DRM_FORMAT_ARGB8888, modifier, &plane_refs);
            if image.is_null() {
                let error = (state.egl.get_error)();
                (state.gbm.bo_destroy)(bo);
                return Err(format!("输出缓冲 eglCreateImage 失败 0x{error:x}"));
            }
            let gl = &state.gl;
            let mut renderbuffer = 0;
            (gl.gen_renderbuffers)(1, &mut renderbuffer);
            (gl.bind_renderbuffer)(GL_RENDERBUFFER, renderbuffer);
            (gl.image_target_renderbuffer_storage)(GL_RENDERBUFFER, image);
            let mut fbo = 0;
            (gl.gen_framebuffers)(1, &mut fbo);
            (gl.bind_framebuffer)(GL_FRAMEBUFFER, fbo);
            (gl.framebuffer_renderbuffer)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, renderbuffer);
            let status = (gl.check_framebuffer_status)(GL_FRAMEBUFFER);
            (gl.bind_framebuffer)(GL_FRAMEBUFFER, 0);
            let target = GpuTarget {
                gpu: self,
                bo,
                image,
                renderbuffer,
                fbo,
                width,
                height,
                planes,
            };
            drop(current);
            if status != GL_FRAMEBUFFER_COMPLETE {
                return Err(format!("输出缓冲的 FBO 不完整 0x{status:x}"));
            }
            Ok(target)
        }
    }

    /// 把 CEF 的一帧拷进输出缓冲，返回时 GPU 已经拷完。
    pub fn blit_to_target(&self, source: &DmaBufSource<'_>, target: &GpuTarget) -> Result<(), String> {
        let current = self.current()?;
        let state = &*current.state;
        // SAFETY: 持锁、上下文当前。
        unsafe { blit(state, source, target.fbo, target.width, target.height, false) }
    }

    /// 把 CEF 的一帧读回到内存（BGRA，行距 `width * 4`），返回时已经读完。
    pub fn blit_to_memory(&self, source: &DmaBufSource<'_>, width: u32, height: u32, out: &mut [u8]) -> Result<(), String> {
        let len = width as usize * height as usize * 4;
        if out.len() < len {
            return Err(format!("读回缓冲太小：{} < {len}", out.len()));
        }
        let mut current = self.current()?;
        let state = &mut *current.state;
        // SAFETY: 持锁、上下文当前；`out` 至少 `len` 字节。
        unsafe {
            let fbo = readback_fbo(state, width, height)?;
            blit(state, source, fbo, width, height, true)?;
            let gl = &state.gl;
            (gl.bind_framebuffer)(GL_FRAMEBUFFER, fbo);
            (gl.pixel_storei)(GL_PACK_ALIGNMENT, 4);
            (gl.read_pixels)(
                0,
                0,
                width as GlInt,
                height as GlInt,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                out.as_mut_ptr().cast(),
            );
            (gl.bind_framebuffer)(GL_FRAMEBUFFER, 0);
            match (gl.get_error)() {
                GL_NO_ERROR => Ok(()),
                error => Err(format!("glReadPixels 出错 0x{error:x}")),
            }
        }
    }
}

impl Drop for GpuTarget {
    fn drop(&mut self) {
        match self.gpu.current() {
            Ok(current) => {
                let state = &*current.state;
                // SAFETY: 持锁、上下文当前；这些对象只属于本缓冲。
                unsafe {
                    (state.gl.delete_framebuffers)(1, &self.fbo);
                    (state.gl.delete_renderbuffers)(1, &self.renderbuffer);
                    (state.egl.destroy_image)(state.display, self.image);
                    (state.gbm.bo_destroy)(self.bo);
                }
            }
            Err(e) => tracing::warn!("释放壁纸推流的输出缓冲失败（GL 对象泄漏）: {e}"),
        }
        // fd 随 `planes` 关闭
    }
}

// ---- 内部工具 ----

fn cstr(pointer: *const c_char) -> String {
    if pointer.is_null() {
        return String::new();
    }
    // SAFETY: EGL / GL 返回的以零结尾的静态字符串。
    unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
}

unsafe fn query_modifiers(egl: &Egl, display: EglDisplay) -> Result<Vec<u64>, String> {
    let mut count: EglInt = 0;
    if (egl.query_dmabuf_modifiers)(
        display,
        DRM_FORMAT_ARGB8888 as EglInt,
        0,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        &mut count,
    ) == 0
    {
        return Err(format!("eglQueryDmaBufModifiersEXT 失败 0x{:x}", (egl.get_error)()));
    }
    let mut modifiers = vec![0u64; count.max(0) as usize];
    let mut external_only = vec![0 as EglBoolean; modifiers.len()];
    if (egl.query_dmabuf_modifiers)(
        display,
        DRM_FORMAT_ARGB8888 as EglInt,
        count,
        modifiers.as_mut_ptr(),
        external_only.as_mut_ptr(),
        &mut count,
    ) == 0
    {
        return Err(format!("eglQueryDmaBufModifiersEXT 失败 0x{:x}", (egl.get_error)()));
    }
    modifiers.truncate(count.max(0) as usize);
    Ok(modifiers
        .into_iter()
        .zip(external_only)
        .filter(|(modifier, external)| *external == 0 && *modifier != DRM_FORMAT_MOD_INVALID)
        .map(|(modifier, _)| modifier)
        .collect())
}

/// 把 dmabuf 的各个 plane 包成 `EGLImage`。`planes` 为 (fd, offset, pitch)。
unsafe fn create_image(
    state: &State,
    width: u32,
    height: u32,
    fourcc: u32,
    modifier: u64,
    planes: &[(c_int, u32, u32)],
) -> EglImage {
    let mut attributes: Vec<EglInt> = vec![
        EGL_WIDTH,
        width as EglInt,
        EGL_HEIGHT,
        height as EglInt,
        EGL_LINUX_DRM_FOURCC_EXT,
        fourcc as EglInt,
    ];
    for (index, (fd, offset, pitch)) in planes.iter().take(4).enumerate() {
        attributes.extend_from_slice(&[
            EGL_PLANE_FD[index],
            *fd,
            EGL_PLANE_OFFSET[index],
            *offset as EglInt,
            EGL_PLANE_PITCH[index],
            *pitch as EglInt,
        ]);
        if modifier != DRM_FORMAT_MOD_INVALID {
            attributes.extend_from_slice(&[
                EGL_PLANE_MODIFIER_LO[index],
                (modifier & 0xffff_ffff) as u32 as EglInt,
                EGL_PLANE_MODIFIER_HI[index],
                (modifier >> 32) as u32 as EglInt,
            ]);
        }
    }
    attributes.push(EGL_NONE);
    (state.egl.create_image)(
        state.display,
        std::ptr::null_mut(),
        EGL_LINUX_DMA_BUF_EXT,
        std::ptr::null_mut(),
        attributes.as_ptr(),
    )
}

/// 导入源帧、画进 `fbo`（`width` × `height`）、`glFinish`、释放源帧。`swap` 为真时输出交换 r / b（读回到 BGRA 内存用）。
unsafe fn blit(
    state: &State,
    source: &DmaBufSource<'_>,
    fbo: GlUint,
    width: u32,
    height: u32,
    swap: bool,
) -> Result<(), String> {
    let fourcc = match source.format {
        OffscreenPixelFormat::Bgra => DRM_FORMAT_ARGB8888,
        OffscreenPixelFormat::Rgba => DRM_FORMAT_ABGR8888,
    };
    let planes: Vec<(c_int, u32, u32)> = source
        .planes
        .iter()
        .map(|plane| (plane.fd, plane.offset as u32, plane.stride))
        .collect();
    let image = create_image(state, source.width, source.height, fourcc, source.modifier, &planes);
    if image.is_null() {
        return Err(format!(
            "导入 CEF 的 dmabuf 失败 0x{:x}（modifier 0x{:x}，{} 个 plane）",
            (state.egl.get_error)(),
            source.modifier,
            planes.len()
        ));
    }
    let gl = &state.gl;
    let mut texture = 0;
    (gl.gen_textures)(1, &mut texture);
    (gl.active_texture)(GL_TEXTURE0);
    (gl.bind_texture)(GL_TEXTURE_EXTERNAL_OES, texture);
    (gl.tex_parameteri)(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    (gl.tex_parameteri)(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    (gl.tex_parameteri)(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    (gl.tex_parameteri)(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    (gl.image_target_texture_2d)(GL_TEXTURE_EXTERNAL_OES, image);

    // 有效区域换算成归一化纹理坐标；dmabuf 第一行在纹理 t = 0、也是输出 FBO 的第一行，不用翻转
    let (vx, vy, vw, vh) = source.visible;
    let (cw, ch) = (source.width.max(1) as f32, source.height.max(1) as f32);
    (gl.bind_framebuffer)(GL_FRAMEBUFFER, fbo);
    (gl.viewport)(0, 0, width as GlInt, height as GlInt);
    (gl.disable)(GL_BLEND);
    (gl.disable)(GL_SCISSOR_TEST);
    (gl.use_program)(state.program);
    (gl.uniform1i)(state.u_tex, 0);
    (gl.uniform4f)(
        state.u_rect,
        vx as f32 / cw,
        vy as f32 / ch,
        vw.max(1) as f32 / cw,
        vh.max(1) as f32 / ch,
    );
    (gl.uniform1f)(state.u_swap, if swap { 1.0 } else { 0.0 });
    (gl.bind_buffer)(GL_ARRAY_BUFFER, 0);
    (gl.vertex_attrib_pointer)(0, 2, GL_FLOAT, 0, 0, QUAD.as_ptr().cast());
    (gl.enable_vertex_attrib_array)(0);
    (gl.draw_arrays)(GL_TRIANGLE_STRIP, 0, 4);
    (gl.finish)();
    let error = (gl.get_error)();

    (gl.bind_texture)(GL_TEXTURE_EXTERNAL_OES, 0);
    (gl.bind_framebuffer)(GL_FRAMEBUFFER, 0);
    (gl.delete_textures)(1, &texture);
    (state.egl.destroy_image)(state.display, image);
    match error {
        GL_NO_ERROR => Ok(()),
        error => Err(format!("拷贝帧时 GL 出错 0x{error:x}")),
    }
}

/// 读回用的 RGBA8 FBO，尺寸变了就重建。
unsafe fn readback_fbo(state: &mut State, width: u32, height: u32) -> Result<GlUint, String> {
    if let Some((_, fbo, w, h)) = state.readback {
        if (w, h) == (width, height) {
            return Ok(fbo);
        }
    }
    let gl = &state.gl;
    if let Some((renderbuffer, fbo, _, _)) = state.readback.take() {
        (gl.delete_framebuffers)(1, &fbo);
        (gl.delete_renderbuffers)(1, &renderbuffer);
    }
    let mut renderbuffer = 0;
    (gl.gen_renderbuffers)(1, &mut renderbuffer);
    (gl.bind_renderbuffer)(GL_RENDERBUFFER, renderbuffer);
    (gl.renderbuffer_storage)(GL_RENDERBUFFER, GL_RGBA8_OES, width as GlInt, height as GlInt);
    let mut fbo = 0;
    (gl.gen_framebuffers)(1, &mut fbo);
    (gl.bind_framebuffer)(GL_FRAMEBUFFER, fbo);
    (gl.framebuffer_renderbuffer)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, renderbuffer);
    let status = (gl.check_framebuffer_status)(GL_FRAMEBUFFER);
    (gl.bind_framebuffer)(GL_FRAMEBUFFER, 0);
    if status != GL_FRAMEBUFFER_COMPLETE {
        (gl.delete_framebuffers)(1, &fbo);
        (gl.delete_renderbuffers)(1, &renderbuffer);
        return Err(format!("读回 FBO 不完整 0x{status:x}"));
    }
    state.readback = Some((renderbuffer, fbo, width, height));
    Ok(fbo)
}

unsafe fn build_program(gl: &Gl) -> Result<GlUint, String> {
    let vertex = compile(gl, GL_VERTEX_SHADER, VERTEX_SHADER)?;
    let fragment = match compile(gl, GL_FRAGMENT_SHADER, FRAGMENT_SHADER) {
        Ok(shader) => shader,
        Err(e) => {
            (gl.delete_shader)(vertex);
            return Err(e);
        }
    };
    let program = (gl.create_program)();
    (gl.attach_shader)(program, vertex);
    (gl.attach_shader)(program, fragment);
    let name = CString::new("a_pos").unwrap();
    (gl.bind_attrib_location)(program, 0, name.as_ptr());
    (gl.link_program)(program);
    (gl.delete_shader)(vertex);
    (gl.delete_shader)(fragment);
    let mut status = 0;
    (gl.get_programiv)(program, GL_LINK_STATUS, &mut status);
    if status == 0 {
        let mut log = vec![0 as c_char; 1024];
        let mut len = 0;
        (gl.get_program_info_log)(program, log.len() as GlInt, &mut len, log.as_mut_ptr());
        return Err(format!("链接着色器失败: {}", cstr(log.as_ptr())));
    }
    Ok(program)
}

unsafe fn compile(gl: &Gl, kind: GlEnum, source: &str) -> Result<GlUint, String> {
    let shader = (gl.create_shader)(kind);
    let source = CString::new(source).unwrap();
    let pointer = source.as_ptr();
    (gl.shader_source)(shader, 1, &pointer, std::ptr::null());
    (gl.compile_shader)(shader);
    let mut status = 0;
    (gl.get_shaderiv)(shader, GL_COMPILE_STATUS, &mut status);
    if status == 0 {
        let mut log = vec![0 as c_char; 1024];
        let mut len = 0;
        (gl.get_shader_info_log)(shader, log.len() as GlInt, &mut len, log.as_mut_ptr());
        (gl.delete_shader)(shader);
        return Err(format!("编译着色器失败: {}", cstr(log.as_ptr())));
    }
    Ok(shader)
}

unsafe fn uniform(gl: &Gl, program: GlUint, name: &str) -> GlInt {
    let name = CString::new(name).unwrap();
    (gl.get_uniform_location)(program, name.as_ptr())
}
