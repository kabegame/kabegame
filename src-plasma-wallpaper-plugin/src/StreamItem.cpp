#include "StreamItem.hpp"

#include <QImage>
#include <QMetaObject>
#include <QOpenGLContext>
#include <QOpenGLFunctions>
#include <QQuickWindow>
#include <QRunnable>
#include <QSGRendererInterface>
#include <QSGSimpleTextureNode>
#include <QtQuick/qsgtexture_platform.h>

// 不要 Xlib 的头（它的 None / Status 等宏与 Qt 冲突）
#define EGL_NO_X11
#define MESA_EGL_NO_X11_HEADERS
#include <EGL/egl.h>
#include <EGL/eglext.h>

#include <pipewire/pipewire.h>
#include <spa/buffer/meta.h>
#include <spa/param/param.h> // 0.3.48 的 Buffers / Meta 枚举在这里，新版由它再 include buffers.h
#include <spa/param/video/format-utils.h>
#include <spa/pod/builder.h>
#include <spa/pod/iter.h>

#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>

#include <algorithm>
#include <cstring>
#include <mutex>
#include <vector>

namespace {

// drm_fourcc.h 的值（不为几个常量依赖 libdrm 的头）
constexpr uint32_t kDrmArgb8888 = 0x34325241; // 'AR24'，内存里 B G R A
constexpr uint32_t kDrmXrgb8888 = 0x34325258; // 'XR24'
constexpr uint64_t kModInvalid = 0x00ffffffffffffffULL;

using ImageTargetTexture2D = void (*)(GLenum target, void* image); // glEGLImageTargetTexture2DOES

void logInfo(const QString& message)
{
    qInfo().noquote() << "[kabegame-wallpaper]" << message;
}

void logWarning(const QString& message)
{
    qWarning().noquote() << "[kabegame-wallpaper]" << message;
}

bool hasExtension(const char* list, const char* name)
{
    if (!list)
        return false;
    const size_t len = std::strlen(name);
    for (const char* p = list; (p = std::strstr(p, name)); p += len) {
        if ((p == list || p[-1] == ' ') && (p[len] == ' ' || p[len] == '\0'))
            return true;
    }
    return false;
}

// 协商出的格式（PipeWire 线程写，add_buffer 时拷进缓冲）
struct Format {
    bool valid = false;
    bool dmabuf = false;
    int width = 0;
    int height = 0;
    uint32_t drmFormat = 0;
    uint64_t modifier = kModInvalid;
    QImage::Format imageFormat = QImage::Format_Invalid;
};

} // namespace

// 一个 PipeWire 缓冲在本端的状态。PipeWire 线程建、渲染线程删；跨线程的字段都在 KabegameStreamCore::mutex 里读写。
struct Slot {
    pw_buffer* buffer = nullptr; // remove_buffer 之后为空
    Format format;

    // dmabuf：自己 dup 的 fd，缓冲移除后仍有效（导入出的 EGLImage 不依赖它，但没导入时要靠它）
    int planes = 0;
    int fd[4] = {-1, -1, -1, -1};
    uint32_t offset[4] = {};
    uint32_t stride[4] = {};
    bool planesKnown = false;

    // 共享内存：自己的映射，缓冲移除后仍有效
    void* map = nullptr;
    size_t mapSize = 0;
    uint32_t mapOffset = 0;
    uint32_t chunkOffset = 0;
    uint32_t chunkStride = 0;

    bool usable = false;

    // 渲染线程
    EGLImageKHR image = EGL_NO_IMAGE_KHR;
    GLuint texture = 0;
    QSGTexture* sgTexture = nullptr;
    bool importFailed = false;

    ~Slot()
    {
        for (int i = 0; i < 4; ++i) {
            if (fd[i] >= 0)
                ::close(fd[i]);
        }
        if (map)
            ::munmap(map, mapSize);
    }
};

struct Retired {
    Slot* slot = nullptr;
    EGLSyncKHR sync = EGL_NO_SYNC_KHR;
    int frames = 0; // 没有 fence 扩展时数帧
};

struct KabegameStreamCore {
    explicit KabegameStreamCore(QObject* item);
    ~KabegameStreamCore();

    // GUI 线程
    void connectStream(uint32_t serial, bool active);
    void setActive(bool active);
    void stop();

    // PipeWire 线程
    void onStateChanged(pw_stream_state state, const char* error);
    void onParamChanged(uint32_t id, const spa_pod* param);
    void onAddBuffer(pw_buffer* buffer);
    void onRemoveBuffer(pw_buffer* buffer);
    void onProcess();
    void onRequeue();

    // 渲染线程
    void checkGraphics();
    bool importSlot(Slot* slot);
    void destroyGl(Slot* slot);
    void releaseAllGl(); // 场景图失效 / 离开窗口
    void giveBack(Slot* slot);
    void signalRequeue();

    void destroyStreamLocked();
    void requestUpdate();
    void postStatus(const QString& status);
    std::vector<const spa_pod*> buildEnumFormats(spa_pod_builder* builder, bool dmabuf);

    QObject* item; // 只用来往 GUI 线程投递

    // PipeWire（GUI 线程在 loop 锁里改，PipeWire 线程在回调里用）
    pw_thread_loop* loop = nullptr;
    pw_context* context = nullptr;
    pw_core* core = nullptr;
    pw_stream* stream = nullptr;
    spa_hook streamListener{};
    spa_source* requeueEvent = nullptr;
    Format format;
    std::vector<Slot*> live; // 当前流的全部缓冲
    std::mutex loopMutex; // 保护 loop 的存续（渲染线程发信号 vs GUI 线程销毁）
    bool loopAlive = false;

    // 跨线程交换
    std::mutex mutex;
    Slot* pending = nullptr; // 收到、还没显示的最新一帧
    Slot* current = nullptr; // 正在显示的 dmabuf 缓冲（只渲染线程改）
    std::vector<Slot*> requeue; // 渲染线程交还，PipeWire 线程入队
    std::vector<Slot*> graveyard; // 已移除，等渲染线程销毁
    std::vector<Slot*> all; // 全部活着的 Slot（渲染线程释放 GL 资源用）

    // 图形能力（渲染线程第一次画时探测；之后 GUI 线程只读）
    bool graphicsChecked = false;
    bool dmabufAllowed = false;
    bool dmabufBroken = false;
    std::vector<uint64_t> modifiers;

    // 渲染线程
    EGLDisplay display = EGL_NO_DISPLAY;
    PFNEGLCREATEIMAGEKHRPROC createImage = nullptr;
    PFNEGLDESTROYIMAGEKHRPROC destroyImage = nullptr;
    PFNEGLCREATESYNCKHRPROC createSync = nullptr;
    PFNEGLDESTROYSYNCKHRPROC destroySync = nullptr;
    PFNEGLCLIENTWAITSYNCKHRPROC clientWaitSync = nullptr;
    ImageTargetTexture2D imageTargetTexture2D = nullptr;
    std::vector<Retired> retired;
    QSGTexture* shmTexture = nullptr;
    QSize shmSize;
};

namespace {

KabegameStreamCore* coreOf(void* data)
{
    return static_cast<KabegameStreamCore*>(data);
}

const pw_stream_events kStreamEvents = {
    .version = PW_VERSION_STREAM_EVENTS,
    .destroy = nullptr,
    .state_changed = [](void* data, pw_stream_state, pw_stream_state state, const char* error) {
        coreOf(data)->onStateChanged(state, error);
    },
    .control_info = nullptr,
    .io_changed = nullptr,
    .param_changed = [](void* data, uint32_t id, const spa_pod* param) { coreOf(data)->onParamChanged(id, param); },
    .add_buffer = [](void* data, pw_buffer* buffer) { coreOf(data)->onAddBuffer(buffer); },
    .remove_buffer = [](void* data, pw_buffer* buffer) { coreOf(data)->onRemoveBuffer(buffer); },
    .process = [](void* data) { coreOf(data)->onProcess(); },
    .drained = nullptr,
};

// 选择值取默认项，普通值原样
const spa_pod* valueOf(const spa_pod_prop* prop, uint32_t* choice = nullptr)
{
    uint32_t n = 0;
    uint32_t c = SPA_CHOICE_None;
    const spa_pod* value = spa_pod_get_values(&prop->value, &n, &c);
    if (choice)
        *choice = c;
    return n > 0 ? value : nullptr;
}

} // namespace

KabegameStreamCore::KabegameStreamCore(QObject* owner)
    : item(owner)
{
    pw_init(nullptr, nullptr);
    loop = pw_thread_loop_new("kabegame-stream", nullptr);
    if (!loop)
        return;
    context = pw_context_new(pw_thread_loop_get_loop(loop), nullptr, 0);
    if (!context || pw_thread_loop_start(loop) < 0) {
        logWarning(QStringLiteral("PipeWire 线程起不来"));
        return;
    }
    pw_thread_loop_lock(loop);
    core = pw_context_connect(context, nullptr, 0);
    requeueEvent = pw_loop_add_event(
        pw_thread_loop_get_loop(loop), [](void* data, uint64_t) { coreOf(data)->onRequeue(); }, this);
    pw_thread_loop_unlock(loop);
    if (!core)
        logWarning(QStringLiteral("连不上 PipeWire"));
    std::lock_guard guard(loopMutex);
    loopAlive = true;
}

KabegameStreamCore::~KabegameStreamCore()
{
    stop();
    // 走到这里时 GL 资源已经在渲染线程上释放（或随上下文没了）；EGLImage 属于 display，不要求上下文
    for (Slot* slot : all) {
        if (slot->image != EGL_NO_IMAGE_KHR && destroyImage)
            destroyImage(display, slot->image);
        delete slot;
    }
    for (const Retired& r : retired) {
        if (r.sync != EGL_NO_SYNC_KHR && destroySync)
            destroySync(display, r.sync);
    }
}

void KabegameStreamCore::stop()
{
    if (!loop)
        return;
    pw_thread_loop_lock(loop);
    destroyStreamLocked();
    pw_thread_loop_unlock(loop);
    {
        std::lock_guard guard(loopMutex);
        loopAlive = false;
    }
    pw_thread_loop_stop(loop);
    if (requeueEvent)
        pw_loop_destroy_source(pw_thread_loop_get_loop(loop), requeueEvent);
    if (core)
        pw_core_disconnect(core);
    if (context)
        pw_context_destroy(context);
    pw_thread_loop_destroy(loop);
    loop = nullptr;
    context = nullptr;
    core = nullptr;
    requeueEvent = nullptr;
}

void KabegameStreamCore::destroyStreamLocked()
{
    if (!stream)
        return;
    // 先断开（期间照常回调 remove_buffer），再摘监听、销毁
    pw_stream_disconnect(stream);
    spa_hook_remove(&streamListener);
    pw_stream_destroy(stream);
    stream = nullptr;
    format = Format();
    std::lock_guard guard(mutex);
    // remove_buffer 没回调到的也当作移除
    for (Slot* slot : live) {
        slot->buffer = nullptr;
        graveyard.push_back(slot);
    }
    live.clear();
    pending = nullptr;
    requeue.clear();
}

std::vector<const spa_pod*> KabegameStreamCore::buildEnumFormats(spa_pod_builder* builder, bool dmabuf)
{
    std::vector<const spa_pod*> params;
    const spa_rectangle defSize{1920, 1080};
    const spa_rectangle minSize{1, 1};
    const spa_rectangle maxSize{16384, 16384};
    const spa_fraction defRate{0, 1};
    const spa_fraction minRate{0, 1};
    const spa_fraction maxRate{1000, 1};
    // 生产端只给 BGRA；dmabuf 在前、共享内存兜底
    for (int pass = dmabuf ? 0 : 1; pass < 2; ++pass) {
        spa_pod_frame frames[2];
        spa_pod_builder_push_object(builder, &frames[0], SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat);
        spa_pod_builder_add(builder, SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video), SPA_FORMAT_mediaSubtype,
                            SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw), SPA_FORMAT_VIDEO_format,
                            SPA_POD_Id(SPA_VIDEO_FORMAT_BGRA), 0);
        if (pass == 0) {
            spa_pod_builder_prop(builder, SPA_FORMAT_VIDEO_modifier,
                                 SPA_POD_PROP_FLAG_MANDATORY | SPA_POD_PROP_FLAG_DONT_FIXATE);
            spa_pod_builder_push_choice(builder, &frames[1], SPA_CHOICE_Enum, 0);
            spa_pod_builder_long(builder, int64_t(modifiers.front()));
            for (uint64_t modifier : modifiers)
                spa_pod_builder_long(builder, int64_t(modifier));
            spa_pod_builder_pop(builder, &frames[1]);
        }
        spa_pod_builder_add(builder, SPA_FORMAT_VIDEO_size, SPA_POD_CHOICE_RANGE_Rectangle(&defSize, &minSize, &maxSize),
                            SPA_FORMAT_VIDEO_framerate, SPA_POD_CHOICE_RANGE_Fraction(&defRate, &minRate, &maxRate), 0);
        params.push_back(static_cast<const spa_pod*>(spa_pod_builder_pop(builder, &frames[0])));
    }
    return params;
}

void KabegameStreamCore::connectStream(uint32_t serial, bool active)
{
    if (!loop || !core)
        return;
    pw_thread_loop_lock(loop);
    destroyStreamLocked();
    if (serial != 0) {
        pw_properties* props = pw_properties_new(PW_KEY_MEDIA_TYPE, "Video", PW_KEY_MEDIA_CATEGORY, "Capture",
                                                 PW_KEY_MEDIA_ROLE, "Screen", nullptr);
        pw_properties_setf(props, PW_KEY_TARGET_OBJECT, "%u", serial);
        stream = pw_stream_new(core, "kabegame-wallpaper-view", props);
        if (stream) {
            pw_stream_add_listener(stream, &streamListener, &kStreamEvents, this);
            uint8_t buffer[4096];
            spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof buffer);
            const bool dmabuf = dmabufAllowed && !dmabufBroken && !modifiers.empty();
            std::vector<const spa_pod*> params = buildEnumFormats(&builder, dmabuf);
            pw_stream_flags flags = pw_stream_flags(PW_STREAM_FLAG_AUTOCONNECT | (active ? 0 : PW_STREAM_FLAG_INACTIVE));
            if (pw_stream_connect(stream, PW_DIRECTION_INPUT, PW_ID_ANY, flags, params.data(), uint32_t(params.size())) < 0)
                postStatus(QStringLiteral("error: pw_stream_connect failed"));
            else
                postStatus(QStringLiteral("waiting (%1)").arg(dmabuf ? QStringLiteral("dmabuf+shm") : QStringLiteral("shm")));
        }
    }
    pw_thread_loop_unlock(loop);
}

void KabegameStreamCore::setActive(bool active)
{
    if (!loop)
        return;
    pw_thread_loop_lock(loop);
    if (stream)
        pw_stream_set_active(stream, active);
    pw_thread_loop_unlock(loop);
}

void KabegameStreamCore::requestUpdate()
{
    QMetaObject::invokeMethod(item, [target = item] { static_cast<QQuickItem*>(target)->update(); }, Qt::QueuedConnection);
}

void KabegameStreamCore::postStatus(const QString& status)
{
    QMetaObject::invokeMethod(item, "applyStatus", Qt::QueuedConnection, Q_ARG(QString, status));
}

void KabegameStreamCore::onStateChanged(pw_stream_state state, const char* error)
{
    if (state == PW_STREAM_STATE_ERROR)
        postStatus(QStringLiteral("error: %1").arg(QString::fromUtf8(error ? error : "")));
}

void KabegameStreamCore::onParamChanged(uint32_t id, const spa_pod* param)
{
    if (id != SPA_PARAM_Format || !param || !stream)
        return;
    Format next;
    uint32_t videoFormat = 0;
    spa_rectangle size{};
    if (const spa_pod_prop* prop = spa_pod_find_prop(param, nullptr, SPA_FORMAT_VIDEO_format)) {
        if (const spa_pod* value = valueOf(prop))
            spa_pod_get_id(value, &videoFormat);
    }
    if (const spa_pod_prop* prop = spa_pod_find_prop(param, nullptr, SPA_FORMAT_VIDEO_size)) {
        if (const spa_pod* value = valueOf(prop))
            spa_pod_get_rectangle(value, &size);
    }
    if (const spa_pod_prop* prop = spa_pod_find_prop(param, nullptr, SPA_FORMAT_VIDEO_modifier)) {
        int64_t modifier = 0;
        if (const spa_pod* value = valueOf(prop); value && spa_pod_get_long(value, &modifier) == 0) {
            next.dmabuf = true;
            next.modifier = uint64_t(modifier);
        }
    }
    switch (videoFormat) {
    case SPA_VIDEO_FORMAT_BGRA:
        next.drmFormat = kDrmArgb8888;
        next.imageFormat = QImage::Format_ARGB32_Premultiplied;
        break;
    case SPA_VIDEO_FORMAT_BGRx:
        next.drmFormat = kDrmXrgb8888;
        next.imageFormat = QImage::Format_RGB32;
        break;
    default:
        postStatus(QStringLiteral("error: unsupported video format %1").arg(videoFormat));
        return;
    }
    next.width = int(size.width);
    next.height = int(size.height);
    next.valid = next.width > 0 && next.height > 0;
    format = next;

    uint8_t buffer[1024];
    spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof buffer);
    const int dataTypes = next.dmabuf ? (1 << SPA_DATA_DmaBuf) : (1 << SPA_DATA_MemFd);
    const spa_pod* params[2];
    // 显示中 1 个 + 等 GPU 读完 1 个 + 待显示 1 个，至少再留 1 个给生产端
    params[0] = static_cast<const spa_pod*>(spa_pod_builder_add_object(
        &builder, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers, SPA_PARAM_BUFFERS_buffers,
        SPA_POD_CHOICE_RANGE_Int(4, 3, 8), SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int(dataTypes)));
    params[1] = static_cast<const spa_pod*>(spa_pod_builder_add_object(
        &builder, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta, SPA_PARAM_META_type, SPA_POD_Id(SPA_META_Header),
        SPA_PARAM_META_size, SPA_POD_Int(int(sizeof(spa_meta_header)))));
    pw_stream_update_params(stream, params, 2);

    if (next.dmabuf)
        postStatus(QStringLiteral("dmabuf %1x%2 modifier 0x%3").arg(next.width).arg(next.height).arg(next.modifier, 0, 16));
    else
        postStatus(QStringLiteral("shm %1x%2").arg(next.width).arg(next.height));
}

void KabegameStreamCore::onAddBuffer(pw_buffer* buffer)
{
    auto* slot = new Slot;
    slot->buffer = buffer;
    slot->format = format;
    spa_buffer* spa = buffer->buffer;
    if (format.valid && spa && spa->n_datas >= 1) {
        spa_data* datas = spa->datas;
        if (datas[0].type == SPA_DATA_DmaBuf && format.dmabuf) {
            slot->planes = int(std::min<uint32_t>(spa->n_datas, 4));
            slot->usable = true;
            for (int i = 0; i < slot->planes; ++i) {
                slot->fd[i] = ::fcntl(int(datas[i].fd), F_DUPFD_CLOEXEC, 3);
                if (slot->fd[i] < 0)
                    slot->usable = false;
            }
        } else if (datas[0].type == SPA_DATA_MemFd && !format.dmabuf) {
            slot->mapSize = size_t(datas[0].mapoffset) + datas[0].maxsize;
            void* map = ::mmap(nullptr, slot->mapSize, PROT_READ, MAP_SHARED, int(datas[0].fd), 0);
            if (map != MAP_FAILED) {
                slot->map = map;
                slot->mapOffset = datas[0].mapoffset;
                slot->usable = true;
            }
        }
    }
    std::lock_guard guard(mutex);
    buffer->user_data = slot;
    live.push_back(slot);
    all.push_back(slot);
}

void KabegameStreamCore::onRemoveBuffer(pw_buffer* buffer)
{
    auto* slot = static_cast<Slot*>(buffer->user_data);
    if (!slot)
        return;
    {
        std::lock_guard guard(mutex);
        buffer->user_data = nullptr;
        slot->buffer = nullptr;
        if (pending == slot)
            pending = nullptr;
        requeue.erase(std::remove(requeue.begin(), requeue.end(), slot), requeue.end());
        live.erase(std::remove(live.begin(), live.end(), slot), live.end());
        graveyard.push_back(slot);
    }
    requestUpdate();
}

void KabegameStreamCore::onProcess()
{
    // 只要最新的一帧，更早的直接还回去
    pw_buffer* newest = nullptr;
    while (pw_buffer* buffer = pw_stream_dequeue_buffer(stream)) {
        if (newest)
            pw_stream_queue_buffer(stream, newest);
        newest = buffer;
    }
    if (!newest)
        return;
    spa_buffer* spa = newest->buffer;
    bool ok = spa && spa->n_datas >= 1;
    if (ok) {
        auto* header = static_cast<spa_meta_header*>(spa_buffer_find_meta_data(spa, SPA_META_Header, sizeof(spa_meta_header)));
        if (header && (header->flags & SPA_META_HEADER_FLAG_CORRUPTED))
            ok = false;
        const spa_chunk* chunk = spa->datas[0].chunk;
        if (!chunk || chunk->size == 0 || (chunk->flags & SPA_CHUNK_FLAG_CORRUPTED))
            ok = false;
    }
    std::lock_guard guard(mutex);
    auto* slot = static_cast<Slot*>(newest->user_data);
    if (!ok || !slot || !slot->usable) {
        pw_stream_queue_buffer(stream, newest);
        return;
    }
    if (slot->format.dmabuf) {
        if (!slot->planesKnown) {
            for (int i = 0; i < slot->planes; ++i) {
                slot->offset[i] = spa->datas[i].chunk->offset;
                slot->stride[i] = uint32_t(spa->datas[i].chunk->stride);
            }
            slot->planesKnown = true;
        }
    } else {
        slot->chunkOffset = spa->datas[0].chunk->offset;
        slot->chunkStride = uint32_t(spa->datas[0].chunk->stride);
    }
    if (pending && pending->buffer)
        pw_stream_queue_buffer(stream, pending->buffer);
    pending = slot;
    requestUpdate();
}

void KabegameStreamCore::onRequeue()
{
    std::lock_guard guard(mutex);
    for (Slot* slot : requeue) {
        if (slot->buffer && stream)
            pw_stream_queue_buffer(stream, slot->buffer);
    }
    requeue.clear();
}

void KabegameStreamCore::signalRequeue()
{
    std::lock_guard guard(loopMutex);
    if (loopAlive && requeueEvent)
        pw_loop_signal_event(pw_thread_loop_get_loop(loop), requeueEvent);
}

void KabegameStreamCore::giveBack(Slot* slot)
{
    std::lock_guard guard(mutex);
    if (slot->buffer)
        requeue.push_back(slot);
}

void KabegameStreamCore::checkGraphics()
{
    graphicsChecked = true;
    QOpenGLContext* context = QOpenGLContext::currentContext();
    const EGLDisplay dpy = context ? eglGetCurrentDisplay() : EGL_NO_DISPLAY;
    if (dpy == EGL_NO_DISPLAY) {
        logInfo(QStringLiteral("没有 EGL 上下文，只用共享内存"));
        return;
    }
    const char* extensions = eglQueryString(dpy, EGL_EXTENSIONS);
    if (!hasExtension(extensions, "EGL_KHR_image_base") || !hasExtension(extensions, "EGL_EXT_image_dma_buf_import")
        || !hasExtension(extensions, "EGL_EXT_image_dma_buf_import_modifiers")) {
        logInfo(QStringLiteral("EGL 不能导入 dmabuf，只用共享内存"));
        return;
    }
    createImage = reinterpret_cast<PFNEGLCREATEIMAGEKHRPROC>(eglGetProcAddress("eglCreateImageKHR"));
    destroyImage = reinterpret_cast<PFNEGLDESTROYIMAGEKHRPROC>(eglGetProcAddress("eglDestroyImageKHR"));
    auto queryModifiers =
        reinterpret_cast<PFNEGLQUERYDMABUFMODIFIERSEXTPROC>(eglGetProcAddress("eglQueryDmaBufModifiersEXT"));
    imageTargetTexture2D = reinterpret_cast<ImageTargetTexture2D>(context->getProcAddress("glEGLImageTargetTexture2DOES"));
    if (hasExtension(extensions, "EGL_KHR_fence_sync")) {
        createSync = reinterpret_cast<PFNEGLCREATESYNCKHRPROC>(eglGetProcAddress("eglCreateSyncKHR"));
        destroySync = reinterpret_cast<PFNEGLDESTROYSYNCKHRPROC>(eglGetProcAddress("eglDestroySyncKHR"));
        clientWaitSync = reinterpret_cast<PFNEGLCLIENTWAITSYNCKHRPROC>(eglGetProcAddress("eglClientWaitSyncKHR"));
    }
    if (!createImage || !destroyImage || !queryModifiers || !imageTargetTexture2D) {
        logInfo(QStringLiteral("缺 dmabuf 导入要用的函数，只用共享内存"));
        return;
    }
    display = dpy;
    EGLint count = 0;
    std::vector<uint64_t> found;
    if (queryModifiers(dpy, EGLint(kDrmArgb8888), 0, nullptr, nullptr, &count) && count > 0) {
        std::vector<EGLuint64KHR> mods(static_cast<size_t>(count));
        std::vector<EGLBoolean> externalOnly(static_cast<size_t>(count));
        if (queryModifiers(dpy, EGLint(kDrmArgb8888), count, mods.data(), externalOnly.data(), &count)) {
            for (EGLint i = 0; i < count; ++i) {
                // 只能当外部纹理采样的不要：这里绑成 GL_TEXTURE_2D
                if (!externalOnly[size_t(i)])
                    found.push_back(mods[size_t(i)]);
            }
        }
    }
    if (std::find(found.begin(), found.end(), kModInvalid) == found.end())
        found.push_back(kModInvalid);
    modifiers = found;
    dmabufAllowed = true;
    logInfo(QStringLiteral("dmabuf 可用：%1 个 modifier，fence %2")
                .arg(qulonglong(modifiers.size()))
                .arg(createSync ? QStringLiteral("有") : QStringLiteral("无")));
}

bool KabegameStreamCore::importSlot(Slot* slot)
{
    if (slot->sgTexture)
        return true;
    if (slot->importFailed || !slot->planesKnown || display == EGL_NO_DISPLAY)
        return false;
    static const EGLint kFd[4] = {EGL_DMA_BUF_PLANE0_FD_EXT, EGL_DMA_BUF_PLANE1_FD_EXT, EGL_DMA_BUF_PLANE2_FD_EXT,
                                  EGL_DMA_BUF_PLANE3_FD_EXT};
    static const EGLint kOffset[4] = {EGL_DMA_BUF_PLANE0_OFFSET_EXT, EGL_DMA_BUF_PLANE1_OFFSET_EXT,
                                      EGL_DMA_BUF_PLANE2_OFFSET_EXT, EGL_DMA_BUF_PLANE3_OFFSET_EXT};
    static const EGLint kPitch[4] = {EGL_DMA_BUF_PLANE0_PITCH_EXT, EGL_DMA_BUF_PLANE1_PITCH_EXT,
                                     EGL_DMA_BUF_PLANE2_PITCH_EXT, EGL_DMA_BUF_PLANE3_PITCH_EXT};
    static const EGLint kModLo[4] = {EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE1_MODIFIER_LO_EXT,
                                     EGL_DMA_BUF_PLANE2_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE3_MODIFIER_LO_EXT};
    static const EGLint kModHi[4] = {EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT, EGL_DMA_BUF_PLANE1_MODIFIER_HI_EXT,
                                     EGL_DMA_BUF_PLANE2_MODIFIER_HI_EXT, EGL_DMA_BUF_PLANE3_MODIFIER_HI_EXT};
    std::vector<EGLint> attribs = {EGL_WIDTH, slot->format.width, EGL_HEIGHT, slot->format.height,
                                   EGL_LINUX_DRM_FOURCC_EXT, EGLint(slot->format.drmFormat)};
    for (int i = 0; i < slot->planes; ++i) {
        attribs.insert(attribs.end(), {kFd[i], slot->fd[i], kOffset[i], EGLint(slot->offset[i]), kPitch[i], EGLint(slot->stride[i])});
        if (slot->format.modifier != kModInvalid) {
            attribs.insert(attribs.end(), {kModLo[i], EGLint(slot->format.modifier & 0xffffffffu), kModHi[i],
                                           EGLint(slot->format.modifier >> 32)});
        }
    }
    attribs.push_back(EGL_NONE);
    slot->image = createImage(display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, nullptr, attribs.data());
    if (slot->image == EGL_NO_IMAGE_KHR) {
        slot->importFailed = true;
        logWarning(QStringLiteral("导入 dmabuf 失败（EGL 0x%1，modifier 0x%2）").arg(eglGetError(), 0, 16).arg(slot->format.modifier, 0, 16));
        return false;
    }
    QOpenGLFunctions* gl = QOpenGLContext::currentContext()->functions();
    while (gl->glGetError() != GL_NO_ERROR) {
    }
    gl->glGenTextures(1, &slot->texture);
    gl->glBindTexture(GL_TEXTURE_2D, slot->texture);
    imageTargetTexture2D(GL_TEXTURE_2D, slot->image);
    gl->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    gl->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    gl->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    gl->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    gl->glBindTexture(GL_TEXTURE_2D, 0);
    if (const GLenum error = gl->glGetError(); error != GL_NO_ERROR) {
        logWarning(QStringLiteral("dmabuf 绑成纹理失败（GL 0x%1）").arg(error, 0, 16));
        destroyGl(slot);
        slot->importFailed = true;
        return false;
    }
    return true;
}

void KabegameStreamCore::destroyGl(Slot* slot)
{
    delete slot->sgTexture;
    slot->sgTexture = nullptr;
    if (slot->texture) {
        if (QOpenGLContext* context = QOpenGLContext::currentContext())
            context->functions()->glDeleteTextures(1, &slot->texture);
        slot->texture = 0;
    }
    if (slot->image != EGL_NO_IMAGE_KHR) {
        destroyImage(display, slot->image);
        slot->image = EGL_NO_IMAGE_KHR;
    }
}

void KabegameStreamCore::releaseAllGl()
{
    for (const Retired& r : retired) {
        if (r.sync != EGL_NO_SYNC_KHR)
            destroySync(display, r.sync);
        giveBack(r.slot);
    }
    retired.clear();
    std::vector<Slot*> dead;
    {
        std::lock_guard guard(mutex);
        if (current) {
            if (current->buffer)
                requeue.push_back(current);
            current = nullptr;
        }
        for (Slot* slot : all)
            destroyGl(slot);
        dead.swap(graveyard);
        for (Slot* slot : dead)
            all.erase(std::remove(all.begin(), all.end(), slot), all.end());
    }
    for (Slot* slot : dead)
        delete slot;
    delete shmTexture;
    shmTexture = nullptr;
    signalRequeue();
}

namespace {

// 离开窗口 / item 销毁后在渲染线程上释放 GL 资源（只持有 core，不碰 item）
class ReleaseJob : public QRunnable {
public:
    explicit ReleaseJob(std::shared_ptr<KabegameStreamCore> core)
        : m_core(std::move(core))
    {
    }
    void run() override { m_core->releaseAllGl(); }

private:
    std::shared_ptr<KabegameStreamCore> m_core;
};

} // namespace

KabegameStreamItem::KabegameStreamItem(QQuickItem* parent)
    : QQuickItem(parent)
    , m_core(std::make_shared<KabegameStreamCore>(this))
{
    setFlag(ItemHasContents, true);
}

KabegameStreamItem::~KabegameStreamItem()
{
    // 先停 PipeWire 线程（之后不再往本对象投递），GL 资源交给渲染线程
    m_core->stop();
    if (QQuickWindow* w = window())
        w->scheduleRenderJob(new ReleaseJob(m_core), QQuickWindow::NoStage);
}

void KabegameStreamItem::setSerial(uint serial)
{
    if (serial == m_serial)
        return;
    m_serial = serial;
    emit serialChanged();
    reconnect();
}

void KabegameStreamItem::applyStatus(const QString& status)
{
    if (status == m_status)
        return;
    m_status = status;
    emit statusChanged();
}

void KabegameStreamItem::reconnect()
{
    if (!m_core->graphicsChecked) {
        // 能不能走 dmabuf 要在渲染线程上看过 GL 上下文才知道：先画一次
        update();
        return;
    }
    m_core->connectStream(m_serial, isVisible());
    if (m_serial == 0)
        applyStatus(QStringLiteral("idle"));
}

void KabegameStreamItem::itemChange(ItemChange change, const ItemChangeData& value)
{
    if (change == ItemVisibleHasChanged)
        m_core->setActive(value.boolValue);
    QQuickItem::itemChange(change, value);
}

void KabegameStreamItem::releaseResources()
{
    if (QQuickWindow* w = window())
        w->scheduleRenderJob(new ReleaseJob(m_core), QQuickWindow::NoStage);
}

void KabegameStreamItem::invalidateSceneGraph()
{
    m_core->releaseAllGl();
}

QSGNode* KabegameStreamItem::updatePaintNode(QSGNode* oldNode, UpdatePaintNodeData*)
{
    KabegameStreamCore& core = *m_core;
    if (!core.graphicsChecked) {
        const bool openGl = window()->rendererInterface()->graphicsApi() == QSGRendererInterface::OpenGL;
        if (openGl)
            core.checkGraphics();
        else
            core.graphicsChecked = true;
        QMetaObject::invokeMethod(this, "reconnect", Qt::QueuedConnection);
    }

    // 取最新一帧；已移除、没在用的缓冲收走
    Slot* next = nullptr;
    uint32_t chunkOffset = 0;
    uint32_t chunkStride = 0;
    std::vector<Slot*> dead;
    {
        std::lock_guard guard(core.mutex);
        next = core.pending;
        core.pending = nullptr;
        if (next && !next->format.dmabuf) {
            chunkOffset = next->chunkOffset;
            chunkStride = next->chunkStride;
        }
        for (auto it = core.graveyard.begin(); it != core.graveyard.end();) {
            Slot* slot = *it;
            const bool retiring = std::any_of(core.retired.begin(), core.retired.end(),
                                              [slot](const Retired& r) { return r.slot == slot; });
            if (slot != core.current && !retiring) {
                dead.push_back(slot);
                core.all.erase(std::remove(core.all.begin(), core.all.end(), slot), core.all.end());
                it = core.graveyard.erase(it);
            } else {
                ++it;
            }
        }
    }
    for (Slot* slot : dead) {
        core.destroyGl(slot);
        delete slot;
    }

    Slot* previous = nullptr;
    QSGTexture* oldShm = nullptr;
    bool requeueNow = false;
    if (next && next->format.dmabuf) {
        if (core.importSlot(next)) {
            next->sgTexture = next->sgTexture
                ? next->sgTexture
                : QNativeInterface::QSGOpenGLTexture::fromNative(next->texture, window(),
                                                                QSize(next->format.width, next->format.height),
                                                                QQuickWindow::TextureHasAlphaChannel);
            std::lock_guard guard(core.mutex);
            previous = core.current;
            core.current = next;
        } else {
            // 导不进来：这一帧还回去，改用共享内存重新连
            core.giveBack(next);
            requeueNow = true;
            if (!core.dmabufBroken) {
                core.dmabufBroken = true;
                QMetaObject::invokeMethod(this, "reconnect", Qt::QueuedConnection);
            }
        }
    } else if (next) {
        const qsizetype bytes = qsizetype(chunkStride) * next->format.height;
        if (next->map && chunkStride > 0 && size_t(next->mapOffset) + chunkOffset + size_t(bytes) <= next->mapSize) {
            const auto* data = static_cast<const uchar*>(next->map) + next->mapOffset + chunkOffset;
            const QImage view(data, next->format.width, next->format.height, qsizetype(chunkStride), next->format.imageFormat);
            // 拷一份：纹理在这一帧渲染时才上传，那时缓冲可能已经还给生产端
            if (QSGTexture* texture = window()->createTextureFromImage(view.copy())) {
                oldShm = core.shmTexture;
                core.shmTexture = texture;
                core.shmSize = QSize(next->format.width, next->format.height);
                std::lock_guard guard(core.mutex);
                previous = core.current;
                core.current = nullptr;
            }
        }
        core.giveBack(next);
        requeueNow = true;
    }

    // 换下来的 dmabuf 缓冲：插 fence，GPU 读完再还给生产端
    if (previous && previous != core.current) {
        Retired retired{previous, EGL_NO_SYNC_KHR, 2};
        if (core.createSync)
            retired.sync = core.createSync(core.display, EGL_SYNC_FENCE_KHR, nullptr);
        core.retired.push_back(retired);
    }
    for (auto it = core.retired.begin(); it != core.retired.end();) {
        bool done;
        if (it->sync != EGL_NO_SYNC_KHR)
            done = core.clientWaitSync(core.display, it->sync, 0, 0) != EGL_TIMEOUT_EXPIRED_KHR;
        else
            done = --it->frames <= 0;
        if (done) {
            if (it->sync != EGL_NO_SYNC_KHR)
                core.destroySync(core.display, it->sync);
            core.giveBack(it->slot);
            requeueNow = true;
            it = core.retired.erase(it);
        } else {
            ++it;
        }
    }
    if (requeueNow)
        core.signalRequeue();

    QSGTexture* texture = core.current ? core.current->sgTexture : core.shmTexture;
    QSGNode* result = nullptr;
    if (texture) {
        auto* node = static_cast<QSGSimpleTextureNode*>(oldNode);
        if (!node) {
            node = new QSGSimpleTextureNode;
            node->setOwnsTexture(false);
            node->setFiltering(QSGTexture::Linear);
        }
        node->setTexture(texture);
        node->setRect(boundingRect());
        result = node;
    } else {
        delete oldNode;
    }
    delete oldShm;

    // 还有等 GPU 的缓冲或待收的缓冲：下一帧再来看
    bool more = !core.retired.empty();
    {
        std::lock_guard guard(core.mutex);
        more = more || !core.graveyard.empty();
    }
    if (more)
        update();
    return result;
}
