//! OpenCV 4.4.0 三个函数的逐位 Rust 移植（resize 线性 / inpaint TELEA / circle LINE_AA 实心圆），
//! 以及 WPE 图标后处理（rea-p11d 2.3 圆形遮罩、2.4 透明区填色）的组合。
//!
//! 出处：OpenCV 4.4.0（BSD 3-Clause License，Copyright (C) 2000-2020 Intel Corporation、
//! Willow Garage、Itseez 等，见 OpenCV 仓库 LICENSE），移植自：
//! - `modules/imgproc/src/resize.cpp`：`cv::resize`、`cv::hal::resize`（INTER_LINEAR 的 8U 定点路径：
//!   `HResizeLinear` / `VResizeLinear` + `ResizeAreaFastVec` 的 2 倍缩小特例）
//! - `modules/photo/src/inpaint.cpp`：`cv::inpaint` → `icvInpaint`（INPAINT_TELEA）、
//!   `CvPriorityQueueFloat`、`FastMarching_solve`、`icvCalcFMM`、`icvTeleaInpaintFMM`（8U 三通道）
//! - `modules/imgproc/src/drawing.cpp`：`cv::circle` → `EllipseEx` → `ellipse2Poly`、
//!   `FillConvexPoly`、`LineAA`、`clipLine`（8U 单通道、LINE_AA、FILLED）
//!
//! 只用 std，所有整数 / 浮点运算顺序与 C++ 一致（float 单精度、`cvRound` = 就近偶数）。
//! 对外只有 [`fill_transparent`] 与 [`circle_mask`]。

#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]

// ============================================================================
// 基础：cvRound（就近偶数，与 SSE cvtsd2si / cvtss2si 默认舍入一致）
// ============================================================================

#[inline]
fn cv_round_f64(v: f64) -> i32 {
    v.round_ties_even() as i32
}

#[inline]
fn cv_round_f32(v: f32) -> i32 {
    v.round_ties_even() as i32
}

/// `saturate_cast<short>(float)`。
#[inline]
fn sat_i16_f32(v: f32) -> i32 {
    cv_round_f32(v).clamp(-32768, 32767)
}

/// `saturate_cast<uchar>(float)`。
#[inline]
fn sat_u8_f32(v: f32) -> u8 {
    cv_round_f32(v).clamp(0, 255) as u8
}

// ============================================================================
// cv::resize，INTER_LINEAR，8 位 1 / 3 通道（resize.cpp：cv::hal::resize）
// ============================================================================

const INTER_RESIZE_COEF_BITS: i32 = 11;
const INTER_RESIZE_COEF_SCALE: i32 = 1 << INTER_RESIZE_COEF_BITS;

/// `cv::resize(src, dst, Size(dw, dh), 0, 0, INTER_LINEAR)`，`cn` 为通道数（本模块只用 1、3）。
pub(crate) fn resize_linear_u8(
    src: &[u8],
    sw: usize,
    sh: usize,
    cn: usize,
    dw: usize,
    dh: usize,
) -> Vec<u8> {
    assert!(sw > 0 && sh > 0 && dw > 0 && dh > 0);
    assert_eq!(src.len(), sw * sh * cn);
    // cv::resize：尺寸相同直接拷贝。
    if dw == sw && dh == sh {
        return src.to_vec();
    }
    let mut dst = vec![0u8; dw * dh * cn];

    // inv_scale 取 dsize / ssize（double），scale = 1 / inv_scale。
    let inv_scale_x = dw as f64 / sw as f64;
    let inv_scale_y = dh as f64 / sh as f64;
    let scale_x = 1.0 / inv_scale_x;
    let scale_y = 1.0 / inv_scale_y;
    let iscale_x = cv_round_f64(scale_x);
    let iscale_y = cv_round_f64(scale_y);
    let is_area_fast = (scale_x - iscale_x as f64).abs() < f64::EPSILON
        && (scale_y - iscale_y as f64).abs() < f64::EPSILON;

    // INTER_LINEAR 且两轴恰为 2 倍缩小：改走 INTER_AREA 的 fast 路径，
    // 8U 用 ResizeAreaFastVec（SIMD 与标量尾部都是 (a+b+c+d+2)>>2）。
    if is_area_fast && iscale_x == 2 && iscale_y == 2 {
        for dy in 0..dh {
            let r0 = &src[(dy * 2) * sw * cn..(dy * 2 + 1) * sw * cn];
            let r1 = &src[(dy * 2 + 1) * sw * cn..(dy * 2 + 2) * sw * cn];
            for dx in 0..dw {
                for k in 0..cn {
                    let s = r0[dx * 2 * cn + k] as i32
                        + r0[(dx * 2 + 1) * cn + k] as i32
                        + r1[dx * 2 * cn + k] as i32
                        + r1[(dx * 2 + 1) * cn + k] as i32;
                    dst[(dy * dw + dx) * cn + k] = ((s + 2) >> 2) as u8;
                }
            }
        }
        return dst;
    }

    // 水平系数：xofs（像素下标）、ialpha（两个 short）。
    let mut xofs = vec![0usize; dw];
    let mut ialpha = vec![[0i32; 2]; dw];
    for dx in 0..dw {
        let fx = ((dx as f64 + 0.5) * scale_x - 0.5) as f32;
        let mut sx = fx.floor() as i32;
        let mut fx = fx - sx as f32;
        if sx < 0 {
            fx = 0.0;
            sx = 0;
        }
        // sx + ksize2 >= src_width 且 sx >= src_width - 1：钳到最后一列、fx = 0
        if sx as i64 >= sw as i64 - 1 {
            fx = 0.0;
            sx = sw as i32 - 1;
        }
        xofs[dx] = sx as usize;
        ialpha[dx] = [
            sat_i16_f32((1.0f32 - fx) * INTER_RESIZE_COEF_SCALE as f32),
            sat_i16_f32(fx * INTER_RESIZE_COEF_SCALE as f32),
        ];
    }
    // 垂直系数。
    let mut yofs = vec![0i32; dh];
    let mut ibeta = vec![[0i32; 2]; dh];
    for dy in 0..dh {
        let fy = ((dy as f64 + 0.5) * scale_y - 0.5) as f32;
        let sy = fy.floor() as i32;
        let fy = fy - sy as f32;
        yofs[dy] = sy;
        ibeta[dy] = [
            sat_i16_f32((1.0f32 - fy) * INTER_RESIZE_COEF_SCALE as f32),
            sat_i16_f32(fy * INTER_RESIZE_COEF_SCALE as f32),
        ];
    }

    // 逐行：水平先算成 int 缓冲（放大 2048 倍），再垂直合成。
    let hrow = |sy: i32| -> Vec<i32> {
        let sy = (sy.max(0) as usize).min(sh - 1);
        let row = &src[sy * sw * cn..(sy + 1) * sw * cn];
        let mut out = vec![0i32; dw * cn];
        for dx in 0..dw {
            let sx = xofs[dx];
            let [a0, a1] = ialpha[dx];
            // 越界的 sx + 1 对应 a1 == 0（sx >= sw - 1 时 fx 被清零），钳位只是避免越界读。
            let sx1 = (sx + 1).min(sw - 1);
            for k in 0..cn {
                out[dx * cn + k] = row[sx * cn + k] as i32 * a0 + row[sx1 * cn + k] as i32 * a1;
            }
        }
        out
    };
    for dy in 0..dh {
        let sy0 = yofs[dy];
        let s0 = hrow(sy0);
        let s1 = hrow(sy0 + 1);
        let [b0, b1] = ibeta[dy];
        for x in 0..dw * cn {
            let v = (((b0 * (s0[x] >> 4)) >> 16) + ((b1 * (s1[x] >> 4)) >> 16) + 2) >> 2;
            dst[dy * dw * cn + x] = v as u8;
        }
    }
    dst
}

// ============================================================================
// cv::inpaint，INPAINT_TELEA，8U 三通道（inpaint.cpp）
// ============================================================================

const KNOWN: u8 = 0;
const BAND: u8 = 1;
const INSIDE: u8 = 2;
const CHANGE: u8 = 3;

const NIL: usize = usize::MAX;

#[derive(Clone, Copy)]
struct HeapElem {
    t: f32,
    i: i32,
    j: i32,
    prev: usize,
    next: usize,
}

/// `CvPriorityQueueFloat`：用数组下标模拟的双向链表（顺序、容量与 C++ 一致）。
struct PriorityQueue {
    mem: Vec<HeapElem>,
    empty: usize,
    head: usize,
    tail: usize,
}

impl PriorityQueue {
    /// `Init`：按 `f` 里非零像素个数分配容量；个数为 0 返回 None。
    fn init(f: &[u8]) -> Option<Self> {
        let num = f.iter().filter(|&&v| v != 0).count();
        if num == 0 {
            return None;
        }
        let blank = HeapElem {
            t: 0.0,
            i: -1,
            j: -1,
            prev: NIL,
            next: NIL,
        };
        let mut mem = vec![blank; num + 2];
        mem[0].prev = NIL;
        mem[0].next = 1;
        mem[0].t = -f32::MAX;
        for i in 1..=num {
            mem[i].prev = i - 1;
            mem[i].next = i + 1;
            mem[i].i = -1;
            mem[i].t = f32::MAX;
        }
        let tail = num + 1;
        mem[tail].i = -1;
        mem[tail].j = -1;
        mem[tail].prev = tail - 1;
        mem[tail].next = NIL;
        mem[tail].t = f32::MAX;
        Some(Self {
            mem,
            empty: 1,
            head: 0,
            tail,
        })
    }

    /// `Add(f)`：把 `f` 里非零像素按行优先、T = 0 依次压入。
    fn add(&mut self, f: &[u8], rows: usize, cols: usize) -> bool {
        for i in 0..rows {
            for j in 0..cols {
                if f[i * cols + j] != 0 && !self.push(i as i32, j as i32, 0.0) {
                    return false;
                }
            }
        }
        true
    }

    fn push(&mut self, i: i32, j: i32, t: f32) -> bool {
        let mut tmp = self.empty;
        let add = self.empty;
        if self.empty == self.tail {
            return false;
        }
        while self.mem[self.mem[tmp].prev].t > t {
            tmp = self.mem[tmp].prev;
        }
        if tmp != self.empty {
            let (ap, an) = (self.mem[add].prev, self.mem[add].next);
            self.mem[ap].next = an;
            self.mem[an].prev = ap;
            self.empty = an;
            let tp = self.mem[tmp].prev;
            self.mem[add].prev = tp;
            self.mem[add].next = tmp;
            self.mem[tp].next = add;
            self.mem[tmp].prev = add;
        } else {
            self.empty = self.mem[self.empty].next;
        }
        self.mem[add].i = i;
        self.mem[add].j = j;
        self.mem[add].t = t;
        true
    }

    fn pop(&mut self) -> Option<(i32, i32)> {
        let tmp = self.mem[self.head].next;
        if self.empty == tmp {
            return None;
        }
        let (i, j) = (self.mem[tmp].i, self.mem[tmp].j);
        let (tp, tn) = (self.mem[tmp].prev, self.mem[tmp].next);
        self.mem[tp].next = tn;
        self.mem[tn].prev = tp;
        let ep = self.mem[self.empty].prev;
        self.mem[tmp].prev = ep;
        self.mem[tmp].next = self.empty;
        self.mem[ep].next = tmp;
        let e = self.empty;
        self.mem[e].prev = tmp;
        self.empty = tmp;
        Some((i, j))
    }
}

/// `min4`（OpenCV 的 `MIN(a, b)` 是 `a > b ? b : a`）。
#[inline]
fn min2(a: f32, b: f32) -> f32 {
    if a > b {
        b
    } else {
        a
    }
}

#[inline]
fn min4(a: f32, b: f32, c: f32, d: f32) -> f32 {
    let a = min2(a, b);
    let c = min2(c, d);
    min2(a, c)
}

/// `FastMarching_solve`：f / t 都是带 1 像素边框的矩阵，行宽 `cols`。
fn fast_marching_solve(
    i1: i32,
    j1: i32,
    i2: i32,
    j2: i32,
    f: &[u8],
    t: &[f32],
    cols: usize,
) -> f32 {
    let ix1 = i1 as usize * cols + j1 as usize;
    let ix2 = i2 as usize * cols + j2 as usize;
    let a11 = t[ix1] as f64;
    let a22 = t[ix2] as f64;
    let m12 = if a11 > a22 { a22 } else { a11 };
    let sol: f64 = if f[ix1] != INSIDE {
        if f[ix2] != INSIDE {
            if (a11 - a22).abs() >= 1.0 {
                1.0 + m12
            } else {
                (a11 + a22 + (2.0 - (a11 - a22) * (a11 - a22)).sqrt()) * 0.5
            }
        } else {
            1.0 + a11
        }
    } else if f[ix2] != INSIDE {
        1.0 + a22
    } else {
        1.0 + m12
    };
    sol as f32
}

/// 四个邻域方向取最小的距离（icvCalcFMM / icvTeleaInpaintFMM 里同一段）。
fn fmm_dist(i: i32, j: i32, f: &[u8], t: &[f32], cols: usize) -> f32 {
    min4(
        fast_marching_solve(i - 1, j, i, j - 1, f, t, cols),
        fast_marching_solve(i + 1, j, i, j - 1, f, t, cols),
        fast_marching_solve(i - 1, j, i, j + 1, f, t, cols),
        fast_marching_solve(i + 1, j, i, j + 1, f, t, cols),
    )
}

/// `icvCalcFMM`（negate = true）：算出洞外 `range` 范围内的带符号距离。
fn calc_fmm_negate(
    f: &mut [u8],
    t: &mut [f32],
    heap: &mut PriorityQueue,
    rows: usize,
    cols: usize,
) {
    while let Some((ii, jj)) = heap.pop() {
        f[ii as usize * cols + jj as usize] = CHANGE;
        for q in 0..4 {
            let (i, j) = match q {
                0 => (ii - 1, jj),
                1 => (ii, jj - 1),
                2 => (ii + 1, jj),
                _ => (ii, jj + 1),
            };
            if i <= 0 || j <= 0 || i > rows as i32 || j > cols as i32 {
                continue;
            }
            let ix = i as usize * cols + j as usize;
            if f[ix] == INSIDE {
                let dist = fmm_dist(i, j, f, t, cols);
                t[ix] = dist;
                f[ix] = BAND;
                heap.push(i, j, dist);
            }
        }
    }
    for ix in 0..rows * cols {
        if f[ix] == CHANGE {
            f[ix] = KNOWN;
            t[ix] = -t[ix];
        }
    }
}

/// `1 + fabs(float)` 的求值精度：C++ 里 `fabs` 对 float 有重载时返回 float、加法在 float 里做；
/// 若解析成 double 版本，则在 double 里做。
const FABS_FLOAT_OVERLOAD: bool = true;
/// `sqrt(Jx*Jx + Jy*Jy)` 同理：float 重载（`sqrtf`）还是 double 版本。
const SQRT_FLOAT_OVERLOAD: bool = true;

/// `icvTeleaInpaintFMM<uchar>`，输出为 8U 三通道。`f` 为带边框的掩码（洞 = INSIDE），
/// `out` 是 `w * h * 3` 的像素数据（不带边框）。
fn telea_inpaint_fmm(
    f: &mut [u8],
    t: &mut [f32],
    out: &mut [u8],
    range: i32,
    heap: &mut PriorityQueue,
    t_rows: i32,
    t_cols: i32,
) {
    let cols = t_cols as usize;
    let step = (t_cols as usize - 2) * 3;
    let px = |out: &[u8], y: i32, x: i32, c: i32| -> i32 {
        out[y as usize * step + x as usize * 3 + c as usize] as i32
    };
    let fi = |ff: &[u8], y: i32, x: i32| ff[y as usize * cols + x as usize];
    let tix = |y: i32, x: i32| y as usize * cols + x as usize;
    while let Some((ii, jj)) = heap.pop() {
        f[ii as usize * cols + jj as usize] = KNOWN;
        for q in 0..4 {
            let (i, j) = match q {
                0 => (ii - 1, jj),
                1 => (ii, jj - 1),
                2 => (ii + 1, jj),
                _ => (ii, jj + 1),
            };
            if i <= 0 || j <= 0 || i > t_rows - 1 || j > t_cols - 1 {
                continue;
            }
            if fi(f, i, j) != INSIDE {
                continue;
            }
            let dist = fmm_dist(i, j, f, t, cols);
            t[tix(i, j)] = dist;

            for color in 0..=2i32 {
                let gradt_x: f32;
                let gradt_y: f32;
                let mut ia = 0.0f32;
                let mut jx = 0.0f32;
                let mut jy = 0.0f32;
                let mut s = 1.0e-20f32;

                if fi(f, i, j + 1) != INSIDE {
                    if fi(f, i, j - 1) != INSIDE {
                        gradt_x = (t[tix(i, j + 1)] - t[tix(i, j - 1)]) * 0.5f32;
                    } else {
                        gradt_x = t[tix(i, j + 1)] - t[tix(i, j)];
                    }
                } else if fi(f, i, j - 1) != INSIDE {
                    gradt_x = t[tix(i, j)] - t[tix(i, j - 1)];
                } else {
                    gradt_x = 0.0;
                }
                if fi(f, i + 1, j) != INSIDE {
                    if fi(f, i - 1, j) != INSIDE {
                        gradt_y = (t[tix(i + 1, j)] - t[tix(i - 1, j)]) * 0.5f32;
                    } else {
                        gradt_y = t[tix(i + 1, j)] - t[tix(i, j)];
                    }
                } else if fi(f, i - 1, j) != INSIDE {
                    gradt_y = t[tix(i, j)] - t[tix(i - 1, j)];
                } else {
                    gradt_y = 0.0;
                }

                for k in (i - range)..=(i + range) {
                    let km = k - 1 + (k == 1) as i32;
                    let kp = k - 1 - (k == t_rows - 2) as i32;
                    for l in (j - range)..=(j + range) {
                        let lm = l - 1 + (l == 1) as i32;
                        let lp = l - 1 - (l == t_cols - 2) as i32;
                        if k > 0
                            && l > 0
                            && k < t_rows - 1
                            && l < t_cols - 1
                            && fi(f, k, l) != INSIDE
                            && (l - j) * (l - j) + (k - i) * (k - i) <= range * range
                        {
                            let ry = (i - k) as f32;
                            let rx = (j - l) as f32;

                            let len = rx * rx + ry * ry; // VectorLength(r)
                            let dst = (1.0f64 / (len as f64 * (len as f64).sqrt())) as f32;
                            let dt = (t[tix(k, l)] - t[tix(i, j)]).abs();
                            let lev = if FABS_FLOAT_OVERLOAD {
                                (1.0f64 / ((1.0f32 + dt) as f64)) as f32
                            } else {
                                (1.0f64 / (1.0f64 + dt as f64)) as f32
                            };

                            let mut dir = rx * gradt_x + ry * gradt_y; // VectorScalMult(r, gradT)
                            if (dir as f64).abs() <= 0.01 {
                                dir = 0.000001f32;
                            }
                            let w = (dst * lev * dir).abs();

                            let grad_ix: f32 = if fi(f, k, l + 1) != INSIDE {
                                if fi(f, k, l - 1) != INSIDE {
                                    ((px(out, km, lp + 1, color) - px(out, km, lm - 1, color))
                                        as f32)
                                        * 2.0f32
                                } else {
                                    (px(out, km, lp + 1, color) - px(out, km, lm, color)) as f32
                                }
                            } else if fi(f, k, l - 1) != INSIDE {
                                (px(out, km, lp, color) - px(out, km, lm - 1, color)) as f32
                            } else {
                                0.0
                            };
                            let grad_iy: f32 = if fi(f, k + 1, l) != INSIDE {
                                if fi(f, k - 1, l) != INSIDE {
                                    ((px(out, kp + 1, lm, color) - px(out, km - 1, lm, color))
                                        as f32)
                                        * 2.0f32
                                } else {
                                    (px(out, kp + 1, lm, color) - px(out, km, lm, color)) as f32
                                }
                            } else if fi(f, k - 1, l) != INSIDE {
                                (px(out, kp, lm, color) - px(out, km - 1, lm, color)) as f32
                            } else {
                                0.0
                            };
                            ia += w * (px(out, km, lm, color) as f32);
                            jx -= w * (grad_ix * rx);
                            jy -= w * (grad_iy * ry);
                            s += w;
                        }
                    }
                }
                let sat: f32 = if SQRT_FLOAT_OVERLOAD {
                    ia / s + (jx + jy) / ((jx * jx + jy * jy).sqrt() + 1.0e-20f32) + 0.5f32
                } else {
                    let den = ((jx * jx + jy * jy) as f64).sqrt() + 1.0e-20f32 as f64;
                    ((ia / s) as f64 + ((jx + jy) as f64) / den + 0.5f32 as f64) as f32
                };
                out[(i - 1) as usize * step + (j - 1) as usize * 3 + color as usize] =
                    sat_u8_f32(sat);
            }

            f[i as usize * cols + j as usize] = BAND;
            heap.push(i, j, dist);
        }
    }
}

/// 8U 掩码的膨胀（矩形核，锚点在中心，越界忽略）：核半径 (rx, ry)。
fn dilate_rect(src: &[u8], rows: usize, cols: usize, rx: usize, ry: usize) -> Vec<u8> {
    let mut dst = vec![0u8; rows * cols];
    for y in 0..rows {
        for x in 0..cols {
            let mut m = 0u8;
            for yy in y.saturating_sub(ry)..=(y + ry).min(rows - 1) {
                for xx in x.saturating_sub(rx)..=(x + rx).min(cols - 1) {
                    m = m.max(src[yy * cols + xx]);
                }
            }
            dst[y * cols + x] = m;
        }
    }
    dst
}

/// 8U 掩码的十字核（3x3）膨胀。
fn dilate_cross(src: &[u8], rows: usize, cols: usize) -> Vec<u8> {
    let mut dst = vec![0u8; rows * cols];
    for y in 0..rows {
        for x in 0..cols {
            let mut m = src[y * cols + x];
            if y > 0 {
                m = m.max(src[(y - 1) * cols + x]);
            }
            if y + 1 < rows {
                m = m.max(src[(y + 1) * cols + x]);
            }
            if x > 0 {
                m = m.max(src[y * cols + x - 1]);
            }
            if x + 1 < cols {
                m = m.max(src[y * cols + x + 1]);
            }
            dst[y * cols + x] = m;
        }
    }
    dst
}

/// `SET_BORDER1_C1`：把矩阵最外一圈置为 `v`。
fn set_border(m: &mut [u8], rows: usize, cols: usize, v: u8) {
    for j in 0..cols {
        m[j] = v;
        m[(rows - 1) * cols + j] = v;
    }
    for i in 1..rows.saturating_sub(1) {
        m[i * cols] = v;
        m[i * cols + cols - 1] = v;
    }
}

/// `cv::inpaint(src, mask, dst, inpaintRange, INPAINT_TELEA)`，8U 三通道（原地修改 `img`）。
/// `mask_in` 为 `w * h` 的 8 位掩码，非 0 表示要补的区域。
pub(crate) fn inpaint_telea_u8c3(
    img: &mut [u8],
    mask_in: &[u8],
    w: usize,
    h: usize,
    inpaint_range: f64,
) {
    assert_eq!(img.len(), w * h * 3);
    assert_eq!(mask_in.len(), w * h);
    let range = cv_round_f64(inpaint_range).clamp(1, 100);
    let ecols = w + 2;
    let erows = h + 2;

    // mask：带 1 像素边框，洞 = INSIDE。
    let mut mask = vec![KNOWN; erows * ecols];
    for i in 0..h {
        for j in 0..w {
            if mask_in[i * w + j] != 0 {
                mask[(i + 1) * ecols + j + 1] = INSIDE;
            }
        }
    }
    set_border(&mut mask, erows, ecols, 0);

    let mut t = vec![1.0e6f32; erows * ecols];
    // band = dilate(mask, 十字核)
    let mut band = dilate_cross(&mask, erows, ecols);
    let Some(mut heap) = PriorityQueue::init(&band) else {
        return;
    };
    // cvSub(band, mask, band)（饱和减）
    for ix in 0..band.len() {
        band[ix] = band[ix].saturating_sub(mask[ix]);
    }
    set_border(&mut band, erows, ecols, 0);
    if !heap.add(&band, erows, ecols) {
        return;
    }
    let mut f = vec![KNOWN; erows * ecols];
    for ix in 0..f.len() {
        if band[ix] != 0 {
            f[ix] = BAND;
        }
    }
    for ix in 0..f.len() {
        if mask[ix] != 0 {
            f[ix] = INSIDE;
        }
    }
    for ix in 0..t.len() {
        if band[ix] != 0 {
            t[ix] = 0.0;
        }
    }

    // TELEA：out = dilate(mask, (2r+1)² 矩形核) - mask
    let r = range as usize;
    let mut out = dilate_rect(&mask, erows, ecols, r, r);
    for ix in 0..out.len() {
        out[ix] = out[ix].saturating_sub(mask[ix]);
    }
    let Some(mut out_heap) = PriorityQueue::init(&out) else {
        return;
    };
    if !out_heap.add(&band, erows, ecols) {
        return;
    }
    for ix in 0..out.len() {
        out[ix] = out[ix].saturating_sub(band[ix]);
    }
    set_border(&mut out, erows, ecols, 0);
    calc_fmm_negate(&mut out, &mut t, &mut out_heap, erows, ecols);
    telea_inpaint_fmm(
        &mut mask,
        &mut t,
        img,
        range,
        &mut heap,
        erows as i32,
        ecols as i32,
    );
}

// ============================================================================
// cv::circle，FILLED + LINE_AA，8U 单通道（drawing.cpp）
// ============================================================================

const XY_SHIFT: i32 = 16;
const XY_ONE: i64 = 1 << XY_SHIFT;

const SLOPE_CORR_TABLE: [u8; 32] = [
    181, 181, 181, 182, 182, 183, 184, 185, 187, 188, 190, 192, 194, 196, 198, 201, 203, 206, 209,
    211, 214, 218, 221, 224, 227, 231, 235, 238, 242, 246, 250, 254,
];

const FILTER_TABLE: [i32; 64] = [
    168, 177, 185, 194, 202, 210, 218, 224, 231, 236, 241, 246, 249, 252, 254, 254, 254, 254, 252,
    249, 246, 241, 236, 231, 224, 218, 210, 202, 194, 185, 177, 168, 158, 149, 140, 131, 122, 114,
    105, 97, 89, 82, 75, 68, 62, 56, 50, 45, 40, 36, 32, 28, 25, 22, 19, 16, 14, 12, 11, 9, 8, 7,
    5, 5,
];

#[derive(Clone, Copy, PartialEq)]
struct P2l {
    x: i64,
    y: i64,
}

/// `clipLine(Size2l, Point2l&, Point2l&)`。
fn clip_line(size_w: i64, size_h: i64, p1: &mut P2l, p2: &mut P2l) -> bool {
    let right = size_w - 1;
    let bottom = size_h - 1;
    if size_w <= 0 || size_h <= 0 {
        return false;
    }
    let (mut x1, mut y1, mut x2, mut y2) = (p1.x, p1.y, p2.x, p2.y);
    let mut c1 =
        (x1 < 0) as i32 + (x1 > right) as i32 * 2 + (y1 < 0) as i32 * 4 + (y1 > bottom) as i32 * 8;
    let mut c2 =
        (x2 < 0) as i32 + (x2 > right) as i32 * 2 + (y2 < 0) as i32 * 4 + (y2 > bottom) as i32 * 8;
    if (c1 & c2) == 0 && (c1 | c2) != 0 {
        if c1 & 12 != 0 {
            let a = if c1 < 8 { 0 } else { bottom };
            x1 += ((a - y1) as f64 * (x2 - x1) as f64 / (y2 - y1) as f64) as i64;
            y1 = a;
            c1 = (x1 < 0) as i32 + (x1 > right) as i32 * 2;
        }
        if c2 & 12 != 0 {
            let a = if c2 < 8 { 0 } else { bottom };
            x2 += ((a - y2) as f64 * (x2 - x1) as f64 / (y2 - y1) as f64) as i64;
            y2 = a;
            c2 = (x2 < 0) as i32 + (x2 > right) as i32 * 2;
        }
        if (c1 & c2) == 0 && (c1 | c2) != 0 {
            if c1 != 0 {
                let a = if c1 == 1 { 0 } else { right };
                y1 += ((a - x1) as f64 * (y2 - y1) as f64 / (x2 - x1) as f64) as i64;
                x1 = a;
                c1 = 0;
            }
            if c2 != 0 {
                let a = if c2 == 1 { 0 } else { right };
                y2 += ((a - x2) as f64 * (y2 - y1) as f64 / (x2 - x1) as f64) as i64;
                x2 = a;
                c2 = 0;
            }
        }
    }
    *p1 = P2l { x: x1, y: y1 };
    *p2 = P2l { x: x2, y: y2 };
    (c1 | c2) == 0
}

/// 单通道 8U 图像（行宽 = width）。
struct Img1<'a> {
    data: &'a mut [u8],
    w: usize,
    h: usize,
}

/// `LineAA`（nch == 1 分支）；`cb` 为颜色第 0 字节。
fn line_aa(img: &mut Img1, mut pt1: P2l, mut pt2: P2l, cb: i32) {
    let size0w = img.w as i64;
    let size0h = img.h as i64;
    if !clip_line(size0w << XY_SHIFT, size0h << XY_SHIFT, &mut pt1, &mut pt2) {
        return;
    }
    let mut dx = pt2.x - pt1.x;
    let mut dy = pt2.y - pt1.y;

    let mut j: i64 = if dx < 0 { -1 } else { 0 };
    let ax = (dx ^ j) - j;
    let mut i: i64 = if dy < 0 { -1 } else { 0 };
    let ay = (dy ^ i) - i;

    let x_step: i64;
    let y_step: i64;
    let mut ecount: i32;
    let mut slope: i32;

    if ax > ay {
        dy = (dy ^ j) - j;
        pt1.x ^= pt2.x & j;
        pt2.x ^= pt1.x & j;
        pt1.x ^= pt2.x & j;
        pt1.y ^= pt2.y & j;
        pt2.y ^= pt1.y & j;
        pt1.y ^= pt2.y & j;

        x_step = XY_ONE;
        y_step = (dy << XY_SHIFT) / (ax | 1);
        pt2.x += XY_ONE;
        ecount = ((pt2.x >> XY_SHIFT) - (pt1.x >> XY_SHIFT)) as i32;
        j = -(pt1.x & (XY_ONE - 1));
        pt1.y += ((y_step * j) >> XY_SHIFT) + (XY_ONE >> 1);
        slope = ((y_step >> (XY_SHIFT - 5)) & 0x3f) as i32;
        slope ^= if y_step < 0 { 0x3f } else { 0 };

        i = (pt1.x >> (XY_SHIFT - 7)) & 0x78;
        j = (pt2.x >> (XY_SHIFT - 7)) & 0x78;
    } else {
        dx = (dx ^ i) - i;
        pt1.x ^= pt2.x & i;
        pt2.x ^= pt1.x & i;
        pt1.x ^= pt2.x & i;
        pt1.y ^= pt2.y & i;
        pt2.y ^= pt1.y & i;
        pt1.y ^= pt2.y & i;

        x_step = (dx << XY_SHIFT) / (ay | 1);
        y_step = XY_ONE;
        pt2.y += XY_ONE;
        ecount = ((pt2.y >> XY_SHIFT) - (pt1.y >> XY_SHIFT)) as i32;
        j = -(pt1.y & (XY_ONE - 1));
        pt1.x += ((x_step * j) >> XY_SHIFT) + (XY_ONE >> 1);
        slope = ((x_step >> (XY_SHIFT - 5)) & 0x3f) as i32;
        slope ^= if x_step < 0 { 0x3f } else { 0 };

        i = (pt1.y >> (XY_SHIFT - 7)) & 0x78;
        j = (pt2.y >> (XY_SHIFT - 7)) & 0x78;
    }

    slope = if slope & 0x20 != 0 {
        0x100
    } else {
        SLOPE_CORR_TABLE[slope as usize] as i32
    };

    // 端点修正表
    let mut ep_table = [0i64; 9];
    {
        let slope64 = slope as i64;
        let t0 = (slope << 7) as i64;
        let t1 = (((0x78 - i as i32) | 4) * slope) as i64;
        let t2 = (((j as i32) | 4) * slope) as i64;
        ep_table[0] = 0;
        ep_table[8] = slope64;
        ep_table[1] = (((((j - i) & 0x78) | 4) * slope64) >> 8) & 0x1ff;
        ep_table[3] = ep_table[1];
        ep_table[2] = (t1 >> 8) & 0x1ff;
        ep_table[4] = (((((j - i) + 0x80) | 4) * slope64) >> 8) & 0x1ff;
        ep_table[5] = ((t1 + t0) >> 8) & 0x1ff;
        ep_table[6] = (t2 >> 8) & 0x1ff;
        ep_table[7] = ((t2 + t0) >> 8) & 0x1ff;
    }

    let mut scount: i32 = 0;
    let w = img.w;
    let put = |data: &mut [u8], x: i64, y: i64, a: i32| {
        let idx = x as usize + y as usize * w;
        let mut c = data[idx] as i32;
        c += ((cb - c) * a + 127) >> 8;
        c += ((cb - c) * a + 127) >> 8;
        data[idx] = c as u8;
    };

    if ax > ay {
        let mut x = (pt1.x >> XY_SHIFT) as i32;
        while ecount >= 0 {
            if (x as u32 as i64) < size0w {
                let y = ((pt1.y >> XY_SHIFT) - 1) as i32;
                let ep_corr = ep_table[((((scount >= 2) as i32 + 1) & (scount | 2)) * 3
                    + (((ecount >= 2) as i32 + 1) & (ecount | 2)))
                    as usize] as i32;
                let dist = ((pt1.y >> (XY_SHIFT - 5)) & 31) as i32;

                let a = ((ep_corr * FILTER_TABLE[(dist + 32) as usize]) >> 8) & 0xff;
                if (y as u32 as i64) < size0h {
                    put(img.data, x as i64, y as i64, a);
                }
                let a = ((ep_corr * FILTER_TABLE[dist as usize]) >> 8) & 0xff;
                if ((y + 1) as u32 as i64) < size0h {
                    put(img.data, x as i64, (y + 1) as i64, a);
                }
                let a = ((ep_corr * FILTER_TABLE[(63 - dist) as usize]) >> 8) & 0xff;
                if ((y + 2) as u32 as i64) < size0h {
                    put(img.data, x as i64, (y + 2) as i64, a);
                }
            }
            x += 1;
            pt1.y += y_step;
            scount += 1;
            ecount -= 1;
        }
    } else {
        let mut y = (pt1.y >> XY_SHIFT) as i32;
        while ecount >= 0 {
            if (y as u32 as i64) < size0h {
                let x = ((pt1.x >> XY_SHIFT) - 1) as i32;
                let ep_corr = ep_table[((((scount >= 2) as i32 + 1) & (scount | 2)) * 3
                    + (((ecount >= 2) as i32 + 1) & (ecount | 2)))
                    as usize] as i32;
                let dist = ((pt1.x >> (XY_SHIFT - 5)) & 31) as i32;

                let a = ((ep_corr * FILTER_TABLE[(dist + 32) as usize]) >> 8) & 0xff;
                if (x as u32 as i64) < size0w {
                    put(img.data, x as i64, y as i64, a);
                }
                let a = ((ep_corr * FILTER_TABLE[dist as usize]) >> 8) & 0xff;
                if ((x + 1) as u32 as i64) < size0w {
                    put(img.data, (x + 1) as i64, y as i64, a);
                }
                let a = ((ep_corr * FILTER_TABLE[(63 - dist) as usize]) >> 8) & 0xff;
                if ((x + 2) as u32 as i64) < size0w {
                    put(img.data, (x + 2) as i64, y as i64, a);
                }
            }
            y += 1;
            pt1.x += x_step;
            scount += 1;
            ecount -= 1;
        }
    }
}

/// `FillConvexPoly(img, v, npts, color, LINE_AA, XY_SHIFT)`，单通道。
fn fill_convex_poly_aa(img: &mut Img1, v: &[P2l], color: u8) {
    let npts = v.len() as i32;
    let shift = XY_SHIFT;
    #[derive(Clone, Copy, Default)]
    struct Edge {
        idx: i32,
        di: i32,
        x: i64,
        dx: i64,
        ye: i32,
    }
    let mut edge = [Edge::default(); 2];

    let delta: i64 = (1i64 << shift) >> 1;
    let mut imin: i32 = 0;
    let mut edges: i32 = npts;
    let (size_w, size_h) = (img.w as i32, img.h as i32);
    let delta1: i64 = XY_ONE - 1;
    let delta2: i64 = 0;

    let mut p0 = v[npts as usize - 1];
    p0.x <<= XY_SHIFT - shift;
    p0.y <<= XY_SHIFT - shift;

    let mut xmin = v[0].x;
    let mut xmax = v[0].x;
    let mut ymin = v[0].y;
    let mut ymax = v[0].y;

    for i in 0..npts {
        let mut p = v[i as usize];
        if p.y < ymin {
            ymin = p.y;
            imin = i;
        }
        ymax = ymax.max(p.y);
        xmax = xmax.max(p.x);
        xmin = xmin.min(p.x);

        p.x <<= XY_SHIFT - shift;
        p.y <<= XY_SHIFT - shift;
        line_aa(img, p0, p, color as i32);
        p0 = p;
    }

    xmin = (xmin + delta) >> shift;
    xmax = (xmax + delta) >> shift;
    ymin = (ymin + delta) >> shift;
    ymax = (ymax + delta) >> shift;

    if npts < 3
        || (xmax as i32) < 0
        || (ymax as i32) < 0
        || (xmin as i32) >= size_w
        || (ymin as i32) >= size_h
    {
        return;
    }

    ymax = ymax.min(size_h as i64 - 1);
    edge[0].idx = imin;
    edge[1].idx = imin;
    let mut y = ymin as i32;
    edge[0].ye = y;
    edge[1].ye = y;
    edge[0].di = 1;
    edge[1].di = npts - 1;
    edge[0].x = -XY_ONE;
    edge[1].x = -XY_ONE;
    edge[0].dx = 0;
    edge[1].dx = 0;

    loop {
        // line_type == LINE_AA：只在 y < ymax 或 y == ymin 时推进边。
        if y < ymax as i32 || y == ymin as i32 {
            for i in 0..2 {
                if y >= edge[i].ye {
                    let mut idx0 = edge[i].idx;
                    let di = edge[i].di;
                    let mut idx = idx0 + di;
                    if idx >= npts {
                        idx -= npts;
                    }
                    loop {
                        // for (; edges-- > 0; )
                        let cont = edges > 0;
                        edges -= 1;
                        if !cont {
                            break;
                        }
                        let ty = ((v[idx as usize].y + delta) >> shift) as i32;
                        if ty > y {
                            let xs = v[idx0 as usize].x;
                            let xe = v[idx as usize].x;
                            edge[i].ye = ty;
                            edge[i].dx = ((xe - xs) * 2 + (ty - y) as i64) / (2 * (ty - y) as i64);
                            edge[i].x = xs;
                            edge[i].idx = idx;
                            break;
                        }
                        idx0 = idx;
                        idx += di;
                        if idx >= npts {
                            idx -= npts;
                        }
                    }
                }
            }
        }

        if edges < 0 {
            break;
        }

        if y >= 0 {
            let (left, right) = if edge[0].x > edge[1].x {
                (1, 0)
            } else {
                (0, 1)
            };
            let mut xx1 = ((edge[left].x + delta1) >> XY_SHIFT) as i32;
            let mut xx2 = ((edge[right].x + delta2) >> XY_SHIFT) as i32;
            if xx2 >= 0 && xx1 < size_w {
                if xx1 < 0 {
                    xx1 = 0;
                }
                if xx2 >= size_w {
                    xx2 = size_w - 1;
                }
                let row = y as usize * img.w;
                // ICV_HLINE（pix_size == 1 即 memset）；xx2 < xx1 时 C 里长度为负，凸多边形下不会出现。
                if xx1 <= xx2 {
                    for x in xx1..=xx2 {
                        img.data[row + x as usize] = color;
                    }
                }
            }
        }

        edge[0].x += edge[0].dx;
        edge[1].x += edge[1].dx;
        y += 1;
        if y > ymax as i32 {
            break;
        }
    }
}

/// OpenCV drawing.cpp 的 `SinTable`（451 项，逐字照抄）。
#[allow(clippy::approx_constant, clippy::excessive_precision)]
const SIN_TABLE: [f32; 451] = [
    0.0000000, 0.0174524, 0.0348995, 0.0523360, 0.0697565, 0.0871557, 0.1045285, 0.1218693,
    0.1391731, 0.1564345, 0.1736482, 0.1908090, 0.2079117, 0.2249511, 0.2419219, 0.2588190,
    0.2756374, 0.2923717, 0.3090170, 0.3255682, 0.3420201, 0.3583679, 0.3746066, 0.3907311,
    0.4067366, 0.4226183, 0.4383711, 0.4539905, 0.4694716, 0.4848096, 0.5000000, 0.5150381,
    0.5299193, 0.5446390, 0.5591929, 0.5735764, 0.5877853, 0.6018150, 0.6156615, 0.6293204,
    0.6427876, 0.6560590, 0.6691306, 0.6819984, 0.6946584, 0.7071068, 0.7193398, 0.7313537,
    0.7431448, 0.7547096, 0.7660444, 0.7771460, 0.7880108, 0.7986355, 0.8090170, 0.8191520,
    0.8290376, 0.8386706, 0.8480481, 0.8571673, 0.8660254, 0.8746197, 0.8829476, 0.8910065,
    0.8987940, 0.9063078, 0.9135455, 0.9205049, 0.9271839, 0.9335804, 0.9396926, 0.9455186,
    0.9510565, 0.9563048, 0.9612617, 0.9659258, 0.9702957, 0.9743701, 0.9781476, 0.9816272,
    0.9848078, 0.9876883, 0.9902681, 0.9925462, 0.9945219, 0.9961947, 0.9975641, 0.9986295,
    0.9993908, 0.9998477, 1.0000000, 0.9998477, 0.9993908, 0.9986295, 0.9975641, 0.9961947,
    0.9945219, 0.9925462, 0.9902681, 0.9876883, 0.9848078, 0.9816272, 0.9781476, 0.9743701,
    0.9702957, 0.9659258, 0.9612617, 0.9563048, 0.9510565, 0.9455186, 0.9396926, 0.9335804,
    0.9271839, 0.9205049, 0.9135455, 0.9063078, 0.8987940, 0.8910065, 0.8829476, 0.8746197,
    0.8660254, 0.8571673, 0.8480481, 0.8386706, 0.8290376, 0.8191520, 0.8090170, 0.7986355,
    0.7880108, 0.7771460, 0.7660444, 0.7547096, 0.7431448, 0.7313537, 0.7193398, 0.7071068,
    0.6946584, 0.6819984, 0.6691306, 0.6560590, 0.6427876, 0.6293204, 0.6156615, 0.6018150,
    0.5877853, 0.5735764, 0.5591929, 0.5446390, 0.5299193, 0.5150381, 0.5000000, 0.4848096,
    0.4694716, 0.4539905, 0.4383711, 0.4226183, 0.4067366, 0.3907311, 0.3746066, 0.3583679,
    0.3420201, 0.3255682, 0.3090170, 0.2923717, 0.2756374, 0.2588190, 0.2419219, 0.2249511,
    0.2079117, 0.1908090, 0.1736482, 0.1564345, 0.1391731, 0.1218693, 0.1045285, 0.0871557,
    0.0697565, 0.0523360, 0.0348995, 0.0174524, 0.0000000, -0.0174524, -0.0348995, -0.0523360,
    -0.0697565, -0.0871557, -0.1045285, -0.1218693, -0.1391731, -0.1564345, -0.1736482, -0.1908090,
    -0.2079117, -0.2249511, -0.2419219, -0.2588190, -0.2756374, -0.2923717, -0.3090170, -0.3255682,
    -0.3420201, -0.3583679, -0.3746066, -0.3907311, -0.4067366, -0.4226183, -0.4383711, -0.4539905,
    -0.4694716, -0.4848096, -0.5000000, -0.5150381, -0.5299193, -0.5446390, -0.5591929, -0.5735764,
    -0.5877853, -0.6018150, -0.6156615, -0.6293204, -0.6427876, -0.6560590, -0.6691306, -0.6819984,
    -0.6946584, -0.7071068, -0.7193398, -0.7313537, -0.7431448, -0.7547096, -0.7660444, -0.7771460,
    -0.7880108, -0.7986355, -0.8090170, -0.8191520, -0.8290376, -0.8386706, -0.8480481, -0.8571673,
    -0.8660254, -0.8746197, -0.8829476, -0.8910065, -0.8987940, -0.9063078, -0.9135455, -0.9205049,
    -0.9271839, -0.9335804, -0.9396926, -0.9455186, -0.9510565, -0.9563048, -0.9612617, -0.9659258,
    -0.9702957, -0.9743701, -0.9781476, -0.9816272, -0.9848078, -0.9876883, -0.9902681, -0.9925462,
    -0.9945219, -0.9961947, -0.9975641, -0.9986295, -0.9993908, -0.9998477, -1.0000000, -0.9998477,
    -0.9993908, -0.9986295, -0.9975641, -0.9961947, -0.9945219, -0.9925462, -0.9902681, -0.9876883,
    -0.9848078, -0.9816272, -0.9781476, -0.9743701, -0.9702957, -0.9659258, -0.9612617, -0.9563048,
    -0.9510565, -0.9455186, -0.9396926, -0.9335804, -0.9271839, -0.9205049, -0.9135455, -0.9063078,
    -0.8987940, -0.8910065, -0.8829476, -0.8746197, -0.8660254, -0.8571673, -0.8480481, -0.8386706,
    -0.8290376, -0.8191520, -0.8090170, -0.7986355, -0.7880108, -0.7771460, -0.7660444, -0.7547096,
    -0.7431448, -0.7313537, -0.7193398, -0.7071068, -0.6946584, -0.6819984, -0.6691306, -0.6560590,
    -0.6427876, -0.6293204, -0.6156615, -0.6018150, -0.5877853, -0.5735764, -0.5591929, -0.5446390,
    -0.5299193, -0.5150381, -0.5000000, -0.4848096, -0.4694716, -0.4539905, -0.4383711, -0.4226183,
    -0.4067366, -0.3907311, -0.3746066, -0.3583679, -0.3420201, -0.3255682, -0.3090170, -0.2923717,
    -0.2756374, -0.2588190, -0.2419219, -0.2249511, -0.2079117, -0.1908090, -0.1736482, -0.1564345,
    -0.1391731, -0.1218693, -0.1045285, -0.0871557, -0.0697565, -0.0523360, -0.0348995, -0.0174524,
    -0.0000000, 0.0174524, 0.0348995, 0.0523360, 0.0697565, 0.0871557, 0.1045285, 0.1218693,
    0.1391731, 0.1564345, 0.1736482, 0.1908090, 0.2079117, 0.2249511, 0.2419219, 0.2588190,
    0.2756374, 0.2923717, 0.3090170, 0.3255682, 0.3420201, 0.3583679, 0.3746066, 0.3907311,
    0.4067366, 0.4226183, 0.4383711, 0.4539905, 0.4694716, 0.4848096, 0.5000000, 0.5150381,
    0.5299193, 0.5446390, 0.5591929, 0.5735764, 0.5877853, 0.6018150, 0.6156615, 0.6293204,
    0.6427876, 0.6560590, 0.6691306, 0.6819984, 0.6946584, 0.7071068, 0.7193398, 0.7313537,
    0.7431448, 0.7547096, 0.7660444, 0.7771460, 0.7880108, 0.7986355, 0.8090170, 0.8191520,
    0.8290376, 0.8386706, 0.8480481, 0.8571673, 0.8660254, 0.8746197, 0.8829476, 0.8910065,
    0.8987940, 0.9063078, 0.9135455, 0.9205049, 0.9271839, 0.9335804, 0.9396926, 0.9455186,
    0.9510565, 0.9563048, 0.9612617, 0.9659258, 0.9702957, 0.9743701, 0.9781476, 0.9816272,
    0.9848078, 0.9876883, 0.9902681, 0.9925462, 0.9945219, 0.9961947, 0.9975641, 0.9986295,
    0.9993908, 0.9998477, 1.0000000,
];

/// `ellipse2Poly(Point2d, Size2d, angle = 0, 0, 360, delta)`。
fn ellipse2poly(center: (f64, f64), axes: (f64, f64), delta: i32) -> Vec<(f64, f64)> {
    let (arc_start, arc_end) = (0i32, 360i32);
    // angle = 0：sincos(0) → cosval = SinTable[450]，sinval = SinTable[0]
    let alpha: f32 = SIN_TABLE[450];
    let beta: f32 = SIN_TABLE[0];
    let mut pts = Vec::new();
    let mut i = arc_start;
    while i < arc_end + delta {
        let mut angle = i;
        if angle > arc_end {
            angle = arc_end;
        }
        if angle < 0 {
            angle += 360;
        }
        let x = axes.0 * SIN_TABLE[(450 - angle) as usize] as f64;
        let y = axes.1 * SIN_TABLE[angle as usize] as f64;
        pts.push((
            center.0 + x * alpha as f64 - y * beta as f64,
            center.1 + x * beta as f64 + y * alpha as f64,
        ));
        i += delta;
    }
    if pts.len() == 1 {
        pts = vec![center, center];
    }
    pts
}

/// `cv::circle(mask, center, radius, Scalar(255), FILLED, LINE_AA, 0)`，单通道 8U。
pub(crate) fn circle_filled_aa(mask: &mut [u8], w: usize, h: usize, cx: i32, cy: i32, radius: i32) {
    assert!(radius >= 0);
    // thickness < 0、line_type != LINE_8 → EllipseEx(center << 16, radius << 16, 0, 0, 360)
    let center = P2l {
        x: (cx as i64) << XY_SHIFT,
        y: (cy as i64) << XY_SHIFT,
    };
    let axes_w = (radius as i64) << XY_SHIFT;
    let axes_h = axes_w;

    let d = ((axes_w.max(axes_h) + (XY_ONE >> 1)) >> XY_SHIFT) as i32;
    let delta = if d < 3 {
        90
    } else if d < 10 {
        30
    } else if d < 15 {
        18
    } else {
        5
    };
    let pts = ellipse2poly(
        (center.x as f64, center.y as f64),
        (axes_w as f64, axes_h as f64),
        delta,
    );

    let mut v: Vec<P2l> = Vec::new();
    let mut prev = P2l { x: -1, y: -1 }; // Point2l(0xFFFF…, 0xFFFF…) = (-1, -1)
    for &(px, py) in &pts {
        let mut pt = P2l {
            x: (cv_round_f64(px / XY_ONE as f64) as i64) << XY_SHIFT,
            y: (cv_round_f64(py / XY_ONE as f64) as i64) << XY_SHIFT,
        };
        pt.x += cv_round_f64(px - pt.x as f64) as i64;
        pt.y += cv_round_f64(py - pt.y as f64) as i64;
        if pt != prev {
            v.push(pt);
            prev = pt;
        }
    }
    if v.len() == 1 {
        v = vec![center, center];
    }

    let mut img = Img1 { data: mask, w, h };
    fill_convex_poly_aa(&mut img, &v, 255);
}

// ============================================================================
// 对外：WPE 图标后处理
// ============================================================================

/// rea-p11d 2.4 透明区填色：只改 alpha ≤ 1 的像素的 RGB，alpha 不动。`rgba.len() == width·height·4`。
///
/// 流程（对应 WPE `FUN_140066ef0`）：丢掉 alpha 得 3 通道；两者都 `resize` 到 64×64（INTER_LINEAR）；
/// 缩小后的 alpha 做 `threshold(8, 255, BINARY)` 再 `bitwise_not`，得到「alpha ≤ 8」的掩码；
/// 对缩小后的 3 通道 `inpaint(8.0, TELEA)`；放大回 `width × height`；
/// 原 alpha ≤ 1 处换成放大后的颜色。
pub fn fill_transparent(rgba: &mut [u8], width: usize, height: usize) {
    assert_eq!(rgba.len(), width * height * 4);
    let n = width * height;
    // cvtColor(BGRA2BGR) + split
    let mut rgb = vec![0u8; n * 3];
    let mut alpha = vec![0u8; n];
    for p in 0..n {
        rgb[p * 3..p * 3 + 3].copy_from_slice(&rgba[p * 4..p * 4 + 3]);
        alpha[p] = rgba[p * 4 + 3];
    }
    let mut small = resize_linear_u8(&rgb, width, height, 3, 64, 64);
    let small_a = resize_linear_u8(&alpha, width, height, 1, 64, 64);
    // threshold(smallA, smallA, 8.0, 255.0, THRESH_BINARY) + bitwise_not：alpha ≤ 8 → 255
    let mask: Vec<u8> = small_a
        .iter()
        .map(|&a| if a > 8 { 0 } else { 255 })
        .collect();
    inpaint_telea_u8c3(&mut small, &mask, 64, 64, 8.0);
    let bg = resize_linear_u8(&small, 64, 64, 3, width, height);
    // t = threshold(alpha, 1.0, 255, BINARY) 取反：alpha ≤ 1 → 255；k = t / 255.0f（0 或 1）
    for p in 0..n {
        let k = (if alpha[p] > 1 { 0u8 } else { 255u8 }) as f32 / 255.0f32;
        for c in 0..3 {
            let v = rgb[p * 3 + c] as f32 * (1.0f32 - k) + bg[p * 3 + c] as f32 * k;
            rgba[p * 4 + c] = (v as i32) as u8;
        }
    }
}

/// rea-p11d 2.3 圆形遮罩：r = (min(w, h) >> 1) − 2（≤ 1 时取 1），圆心 (w >> 1, h >> 1)，
/// LINE_AA 实心圆，a = (mask·a) >> 8。
pub fn circle_mask(rgba: &mut [u8], width: usize, height: usize) {
    assert_eq!(rgba.len(), width * height * 4);
    let mut mask = vec![0u8; width * height];
    let mut r = (width.min(height) >> 1) as i32 - 2;
    if r <= 1 {
        r = 1;
    }
    circle_filled_aa(
        &mut mask,
        width,
        height,
        (width >> 1) as i32,
        (height >> 1) as i32,
        r,
    );
    for p in 0..width * height {
        let a = rgba[p * 4 + 3] as u32;
        rgba[p * 4 + 3] = ((mask[p] as u32 * a) >> 8) as u8;
    }
}

#[cfg(test)]
mod tests {
    //! 输入用固定种子的 xorshift 生成，期望值是 OpenCV（cv2）对同一输入的输出的 64 位 FNV-1a 哈希。
    //! 期望值由 oracle/gen_tests.py 生成（参照：opencv-python 4.5.5，这几个函数与 4.4.0 行为一致）。
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
    }

    fn fnv(data: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for &b in data {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
        h
    }

    /// 渐变 + 噪声 + 一块纯色矩形（逐像素逐通道，行优先）。
    fn gen_img(seed: u64, w: usize, h: usize, cn: usize) -> Vec<u8> {
        let mut r = Rng(seed);
        let mut out = Vec::with_capacity(w * h * cn);
        for y in 0..h {
            for x in 0..w {
                for c in 0..cn {
                    let base = (x * 255 / (w - 1).max(1) * (c + 1)
                        + y * 255 / (h - 1).max(1) * (3 - c))
                        / 4;
                    let mut v = (base + (r.next() & 0x1f) as usize).min(255);
                    if x >= w / 4 && x < w / 4 + w / 2 && y >= h / 4 && y < h / 4 + h / 3 {
                        v = 50 + c * 70;
                    }
                    out.push(v as u8);
                }
            }
        }
        out
    }

    fn mask_hole(w: usize, h: usize) -> Vec<u8> {
        let mut m = vec![0u8; w * h];
        for y in h / 3..h / 3 + h / 5 {
            for x in w / 3..w / 3 + w / 4 {
                m[y * w + x] = 255;
            }
        }
        m
    }

    fn mask_ring(w: usize, h: usize, t: usize) -> Vec<u8> {
        let mut m = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                if x < t || y < t || x >= w - t || y >= h - t {
                    m[y * w + x] = 255;
                }
            }
        }
        m
    }

    fn mask_big(w: usize, h: usize) -> Vec<u8> {
        let mut m = vec![255u8; w * h];
        for y in h / 4..h / 4 + h / 5 {
            for x in w / 4..w / 4 + w / 5 {
                m[y * w + x] = 0;
            }
        }
        m
    }

    /// RGBA：圆形软边 alpha（圆外 0、边缘 3 像素渐变），颜色用 gen_img。
    fn gen_icon(seed: u64, w: usize, h: usize) -> Vec<u8> {
        let rgb = gen_img(seed, w, h, 3);
        let r = (w.min(h) / 2) as i64 - 2;
        let (cx, cy) = ((w / 2) as i64, (h / 2) as i64);
        let mut out = Vec::with_capacity(w * h * 4);
        for y in 0..h {
            for x in 0..w {
                let d2 = (x as i64 - cx).pow(2) + (y as i64 - cy).pow(2);
                let a = if d2 <= (r - 3) * (r - 3) {
                    255
                } else if d2 >= r * r {
                    0
                } else {
                    255 * (r * r - d2) / (r * r - (r - 3) * (r - 3))
                };
                let p = (y * w + x) * 3;
                out.extend_from_slice(&rgb[p..p + 3]);
                out.push(a as u8);
            }
        }
        out
    }

    /// RGBA：随机颜色，alpha 一半 255、其余随机。
    fn gen_rgba_alpha(seed: u64, w: usize, h: usize) -> Vec<u8> {
        let mut r = Rng(seed);
        let mut out = Vec::with_capacity(w * h * 4);
        for _ in 0..w * h {
            let v = r.next();
            let a = if (v >> 40) & 1 == 1 {
                255
            } else {
                (v >> 24) & 255
            };
            out.extend_from_slice(&[
                (v & 255) as u8,
                ((v >> 8) & 255) as u8,
                ((v >> 16) & 255) as u8,
                a as u8,
            ]);
        }
        out
    }

    #[test]
    fn resize_down_256_c3() {
        let src = gen_img(1323, 256, 256, 3);
        let out = resize_linear_u8(&src, 256, 256, 3, 64, 64);
        assert_eq!(fnv(&out), 0x1b7854586794364d);
    }

    #[test]
    fn resize_down_256_c1() {
        let src = gen_img(1321, 256, 256, 1);
        let out = resize_linear_u8(&src, 256, 256, 1, 64, 64);
        assert_eq!(fnv(&out), 0x3bd255c316f0b1d6);
    }

    #[test]
    fn resize_down_160x100_c3() {
        let src = gen_img(1227, 160, 100, 3);
        let out = resize_linear_u8(&src, 160, 100, 3, 64, 64);
        assert_eq!(fnv(&out), 0xdb86321dfdf8a9e6);
    }

    #[test]
    fn resize_down_160x100_c1() {
        let src = gen_img(1225, 160, 100, 1);
        let out = resize_linear_u8(&src, 160, 100, 1, 64, 64);
        assert_eq!(fnv(&out), 0xf2ffa9a2058b0071);
    }

    #[test]
    fn resize_up_256_c3() {
        let src = gen_img(1323, 64, 64, 3);
        let out = resize_linear_u8(&src, 64, 64, 3, 256, 256);
        assert_eq!(fnv(&out), 0x2173b2dd459bbc53);
    }

    #[test]
    fn resize_up_256_c1() {
        let src = gen_img(1321, 64, 64, 1);
        let out = resize_linear_u8(&src, 64, 64, 1, 256, 256);
        assert_eq!(fnv(&out), 0x594c774739506b8f);
    }

    #[test]
    fn resize_up_300x170_c3() {
        let src = gen_img(1237, 64, 64, 3);
        let out = resize_linear_u8(&src, 64, 64, 3, 300, 170);
        assert_eq!(fnv(&out), 0xa27b47746de1776d);
    }

    #[test]
    fn resize_up_300x170_c1() {
        let src = gen_img(1235, 64, 64, 1);
        let out = resize_linear_u8(&src, 64, 64, 1, 300, 170);
        assert_eq!(fnv(&out), 0x7dd0b5dcc805a9e9);
    }

    #[test]
    fn resize_down_300x170_c3() {
        let src = gen_img(1367, 300, 170, 3);
        let out = resize_linear_u8(&src, 300, 170, 3, 64, 64);
        assert_eq!(fnv(&out), 0x2019a414caa45a78);
    }

    #[test]
    fn resize_down_300x170_c1() {
        let src = gen_img(1365, 300, 170, 1);
        let out = resize_linear_u8(&src, 300, 170, 1, 64, 64);
        assert_eq!(fnv(&out), 0x0307e440903c2aec);
    }

    #[test]
    fn resize_down_2x_c3() {
        let src = gen_img(1195, 128, 128, 3);
        let out = resize_linear_u8(&src, 128, 128, 3, 64, 64);
        assert_eq!(fnv(&out), 0x11721b8ccdf8e6f6);
    }

    #[test]
    fn resize_down_2x_c1() {
        let src = gen_img(1193, 128, 128, 1);
        let out = resize_linear_u8(&src, 128, 128, 1, 64, 64);
        assert_eq!(fnv(&out), 0x65fd874991161204);
    }

    #[test]
    fn resize_down_7x5_c3() {
        let src = gen_img(1072, 64, 64, 3);
        let out = resize_linear_u8(&src, 64, 64, 3, 7, 5);
        assert_eq!(fnv(&out), 0x8230dd88ec77c08d);
    }

    #[test]
    fn resize_down_7x5_c1() {
        let src = gen_img(1070, 64, 64, 1);
        let out = resize_linear_u8(&src, 64, 64, 1, 7, 5);
        assert_eq!(fnv(&out), 0xb1317b7e9c0b23d7);
    }

    #[test]
    fn inpaint_hole() {
        let mut out = gen_img(2000, 64, 64, 3);
        let mask = mask_hole(64, 64);
        inpaint_telea_u8c3(&mut out, &mask, 64, 64, 8.0);
        assert_eq!(fnv(&out), 0x8dd23ef7f7190b58);
    }

    #[test]
    fn inpaint_ring() {
        let mut out = gen_img(2000, 64, 64, 3);
        let mask = mask_ring(64, 64, 3);
        inpaint_telea_u8c3(&mut out, &mask, 64, 64, 8.0);
        assert_eq!(fnv(&out), 0xb1ea86d7de2065e9);
    }

    #[test]
    fn inpaint_big() {
        let mut out = gen_img(2000, 64, 64, 3);
        let mask = mask_big(64, 64);
        inpaint_telea_u8c3(&mut out, &mask, 64, 64, 8.0);
        assert_eq!(fnv(&out), 0x009ea0a7947d83ae);
    }

    #[test]
    fn inpaint_ring8() {
        let mut out = gen_img(2000, 64, 64, 3);
        let mask = mask_ring(64, 64, 9);
        inpaint_telea_u8c3(&mut out, &mask, 64, 64, 8.0);
        assert_eq!(fnv(&out), 0x4883e08d899af167);
    }

    #[test]
    fn fill_transparent_256x256() {
        let mut out = gen_icon(3256, 256, 256);
        fill_transparent(&mut out, 256, 256);
        assert_eq!(fnv(&out), 0x4f65516b1ac11a87);
    }

    #[test]
    fn fill_transparent_160x160() {
        let mut out = gen_icon(3160, 160, 160);
        fill_transparent(&mut out, 160, 160);
        assert_eq!(fnv(&out), 0xe9acb6f95828d1cf);
    }

    #[test]
    fn fill_transparent_300x200() {
        let mut out = gen_icon(3300, 300, 200);
        fill_transparent(&mut out, 300, 200);
        assert_eq!(fnv(&out), 0xe4bee0a9e70d992f);
    }

    #[test]
    fn fill_transparent_128x128() {
        let mut out = gen_icon(3128, 128, 128);
        fill_transparent(&mut out, 128, 128);
        assert_eq!(fnv(&out), 0xa2db0d01116a78dc);
    }

    #[test]
    fn fill_transparent_64x64() {
        let mut out = gen_icon(3064, 64, 64);
        fill_transparent(&mut out, 64, 64);
        assert_eq!(fnv(&out), 0x31882d7ffe9f9524);
    }

    #[test]
    fn fill_transparent_96x40() {
        let mut out = gen_icon(3096, 96, 40);
        fill_transparent(&mut out, 96, 40);
        assert_eq!(fnv(&out), 0x830abfb472e0eb72);
    }

    #[test]
    fn circle_mask_256x256() {
        let mut out = gen_rgba_alpha(4512, 256, 256);
        circle_mask(&mut out, 256, 256);
        assert_eq!(fnv(&out), 0x2525eefe55582aa8);
    }

    #[test]
    fn circle_mask_160x160() {
        let mut out = gen_rgba_alpha(4320, 160, 160);
        circle_mask(&mut out, 160, 160);
        assert_eq!(fnv(&out), 0x6f30df204076be3d);
    }

    #[test]
    fn circle_mask_300x300() {
        let mut out = gen_rgba_alpha(4600, 300, 300);
        circle_mask(&mut out, 300, 300);
        assert_eq!(fnv(&out), 0x6e5bf6854c01fc73);
    }

    #[test]
    fn circle_mask_7x5() {
        let mut out = gen_rgba_alpha(4012, 7, 5);
        circle_mask(&mut out, 7, 5);
        assert_eq!(fnv(&out), 0x34a8d0c2b6a9fcf0);
    }

    #[test]
    fn circle_mask_300x200() {
        let mut out = gen_rgba_alpha(4500, 300, 200);
        circle_mask(&mut out, 300, 200);
        assert_eq!(fnv(&out), 0x5545dd797be96e8c);
    }

    #[test]
    fn circle_mask_4x4() {
        let mut out = gen_rgba_alpha(4008, 4, 4);
        circle_mask(&mut out, 4, 4);
        assert_eq!(fnv(&out), 0x3d8df3fed0841aa0);
    }
}
