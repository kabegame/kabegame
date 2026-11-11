use super::*;
use image::Rgba;

const RED: u32 = 0xff0000;
const GREEN: u32 = 0x00ff00;
const BLUE: u32 = 0x0000ff;
const WHITE: u32 = 0xffffff;

fn solid(width: u32, height: u32, rgba: [u8; 4]) -> RgbaImage {
    RgbaImage::from_pixel(width, height, Rgba(rgba))
}

fn cell(l: f32, a: f32, b: f32) -> Cell {
    Cell {
        color: Oklab { l, a, b },
        weight: 1.0,
    }
}

fn palette(colors: &[(u32, u8)]) -> Palette {
    Palette(
        colors
            .iter()
            .map(|&(rgb, percent)| PaletteColor { rgb, percent })
            .collect(),
    )
}

fn channels(rgb: u32) -> [i32; 3] {
    [
        ((rgb >> 16) & 0xff) as i32,
        ((rgb >> 8) & 0xff) as i32,
        (rgb & 0xff) as i32,
    ]
}

/// 两个 rgb 的各通道相差都不超过 `tolerance`。
fn rgb_close(x: u32, y: u32, tolerance: i32) -> bool {
    channels(x)
        .iter()
        .zip(channels(y))
        .all(|(p, q)| (p - q).abs() <= tolerance)
}

/// 确定性的伪随机数（测试里造噪点用）。
fn noise(seed: &mut u32) -> u32 {
    *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    *seed >> 16
}

fn hsv_to_rgb(hue: f32) -> [u8; 3] {
    let sector = (hue / 60.0) % 6.0;
    let x = 1.0 - (sector % 2.0 - 1.0).abs();
    let (r, g, b) = match sector as u32 {
        0 => (1.0, x, 0.0),
        1 => (x, 1.0, 0.0),
        2 => (0.0, 1.0, x),
        3 => (0.0, x, 1.0),
        4 => (x, 0.0, 1.0),
        _ => (1.0, 0.0, x),
    };
    [
        (r * 255.0_f32).round() as u8,
        (g * 255.0_f32).round() as u8,
        (b * 255.0_f32).round() as u8,
    ]
}

// ---------------------------------------------------------------------------
// 聚合与选取：01-palette.md 点 4 的行为表，每行一个用例
// ---------------------------------------------------------------------------

#[test]
fn solid_image_gives_one_color() {
    let image = solid(64, 48, [200, 30, 40, 255]);
    let result = palette_from_frames(std::iter::once(&image)).unwrap();
    assert_eq!(result, palette(&[(0xc81e28, 100)]));
}

#[test]
fn solid_image_with_slight_noise_gives_one_color() {
    let mut seed = 7;
    let mut image = solid(512, 512, [0, 0, 0, 255]);
    for pixel in image.pixels_mut() {
        let jitter = |base: u8, seed: &mut u32| (base as i32 + (noise(seed) % 9) as i32 - 4) as u8;
        *pixel = Rgba([
            jitter(60, &mut seed),
            jitter(120, &mut seed),
            jitter(180, &mut seed),
            255,
        ]);
    }
    let result = palette_from_frames(std::iter::once(&image)).unwrap();
    assert_eq!(result.0.len(), 1, "{result:?}");
    assert_eq!(result.0[0].percent, 100);
    assert!(rgb_close(result.0[0].rgb, 0x3c78b4, 2), "{result:?}");
}

#[test]
fn half_red_half_blue_gives_two_halves() {
    let mut image = solid(64, 64, [255, 0, 0, 255]);
    for (x, _, pixel) in image.enumerate_pixels_mut() {
        if x >= 32 {
            *pixel = Rgba([0, 0, 255, 255]);
        }
    }
    let result = palette_from_frames(std::iter::once(&image)).unwrap();
    // 占比并列时按 rgb 升序：蓝在前
    assert_eq!(result, palette(&[(BLUE, 50), (RED, 50)]));
}

#[test]
fn narrow_gradient_merges_into_its_average() {
    // 256 个区域，a 通道跨 0.04（小于合并半径），无论哪个点当种子都能收走全部
    let cells: Vec<Cell> = (0..256)
        .map(|index| cell(0.6, -0.02 + 0.04 * index as f32 / 255.0, 0.05))
        .collect();

    let clusters = merge_cells(cells, MERGE_RADIUS);

    assert_eq!(clusters.len(), 1);
    assert_eq!(clusters[0].weight, 256.0);
    assert!((clusters[0].color.l - 0.6).abs() < 1e-5);
    assert!(clusters[0].color.a.abs() < 1e-5, "{:?}", clusters[0]);
    assert!((clusters[0].color.b - 0.05).abs() < 1e-5);
}

/// a 通道从 -0.1188 到 0.1188 的均匀渐变（略小于合并半径的 4 倍），步长 0.00099、241 个点。
/// 离一个点不超过半径的是它左右各 60 步。
fn wide_gradient() -> Vec<Cell> {
    (-120..=120)
        .map(|step| cell(0.6, step as f32 * 0.00099, 0.0))
        .collect()
}

#[test]
fn gradient_four_radii_wide_is_cut_from_its_densest_points() {
    let clusters = merge_cells(wide_gradient(), MERGE_RADIUS);

    // 第 -60..=60 步的点左右都有满 60 步的邻居，密度同为 121，并列按下标取第 -60 步当种子，
    // 收走 -120..=0；剩下的点里 1..=60 步密度仍是 121，取第 1 步，收走 1..=61；
    // 最后 62..=120 步里第 62 步最密，收走其余。
    assert_eq!(clusters.len(), 3, "{clusters:?}");
    assert_eq!(clusters[0].weight, 121.0);
    assert!(
        (clusters[0].color.a + 60.0 * 0.00099).abs() < 1e-5,
        "{clusters:?}"
    );
    assert_eq!(clusters[1].weight, 61.0);
    assert!(
        (clusters[1].color.a - 31.0 * 0.00099).abs() < 1e-5,
        "{clusters:?}"
    );
    assert_eq!(clusters[2].weight, 59.0);
    assert!(
        (clusters[2].color.a - 91.0 * 0.00099).abs() < 1e-5,
        "{clusters:?}"
    );
}

#[test]
fn two_distant_blobs_give_their_own_averages() {
    // 两团相距 0.2，各自内部跨 0.02
    let mut cells = Vec::new();
    for index in 0..40 {
        let offset = index as f32 * 0.0005;
        cells.push(cell(0.6, 0.10 + offset, 0.0));
    }
    for index in 0..20 {
        let offset = index as f32 * 0.001;
        cells.push(cell(0.6, -0.10 - offset, 0.0));
    }

    let mut clusters = merge_cells(cells, MERGE_RADIUS);
    clusters.sort_by(|x, y| y.weight.total_cmp(&x.weight));

    assert_eq!(clusters.len(), 2, "{clusters:?}");
    assert_eq!(clusters[0].weight, 40.0);
    assert!((clusters[0].color.a - (0.10 + 19.5 * 0.0005)).abs() < 1e-5);
    assert_eq!(clusters[1].weight, 20.0);
    assert!((clusters[1].color.a + (0.10 + 9.5 * 0.001)).abs() < 1e-5);
}

#[test]
fn cluster_color_is_the_member_average_not_the_seed() {
    // 41 个点均匀铺在 a ∈ [0.10, 0.14]，两两都不到半径：密度全是 41，并列按下标取 a = 0.10 当种子。
    // 聚合点的颜色是全部成员的平均 0.12，不是种子。
    let cells: Vec<Cell> = (0..=40)
        .map(|step| cell(0.6, 0.10 + step as f32 * 0.001, 0.0))
        .collect();

    let clusters = merge_cells(cells, MERGE_RADIUS);

    assert_eq!(clusters.len(), 1, "{clusters:?}");
    assert_eq!(clusters[0].weight, 41.0);
    assert!((clusters[0].color.a - 0.12).abs() < 1e-5, "{clusters:?}");
    assert!(
        (clusters[0].color.a - 0.10).abs() > 0.015,
        "color is the seed"
    );
}

#[test]
fn seed_is_the_densest_point() {
    // 输入顺序：一个离群点、3 个点的稀疏团（a = 0）、10 个点的密集团（a = 0.20）。
    // 包围盒中心在 a = -0.05，旧做法会先从稀疏团取种子；按密度取，先取密集团。
    let mut cells = vec![cell(0.6, -0.30, 0.0)];
    cells.extend((0..3).map(|_| cell(0.6, 0.0, 0.0)));
    cells.extend((0..10).map(|step| cell(0.6, 0.20 + step as f32 * 0.002, 0.0)));

    let clusters = merge_cells(cells, MERGE_RADIUS);

    assert_eq!(clusters.len(), 3, "{clusters:?}");
    // 输出按种子被取到的先后：最密的在前，离群点（密度 1）在最后
    assert_eq!(clusters[0].weight, 10.0);
    assert!((clusters[0].color.a - 0.209).abs() < 1e-5, "{clusters:?}");
    assert_eq!(clusters[1].weight, 3.0);
    assert_eq!(clusters[2].weight, 1.0);

    // 密度相同时按下标：两团一样大，先取排在前面的那团
    let mut tie: Vec<Cell> = (0..4).map(|_| cell(0.6, 0.20, 0.0)).collect();
    tie.extend((0..4).map(|_| cell(0.6, -0.20, 0.0)));
    let clusters = merge_cells(tie, MERGE_RADIUS);
    assert_eq!(clusters.len(), 2);
    assert!((clusters[0].color.a - 0.20).abs() < 1e-6);
    assert!((clusters[1].color.a + 0.20).abs() < 1e-6);

    // 权重算进密度：一个权重 5 的点比 3 个权重 1 的点密
    let weighted = vec![
        cell(0.6, 0.0, 0.0),
        cell(0.6, 0.0, 0.0),
        cell(0.6, 0.0, 0.0),
        Cell {
            color: Oklab {
                l: 0.6,
                a: 0.30,
                b: 0.0,
            },
            weight: 5.0,
        },
    ];
    let clusters = merge_cells(weighted, MERGE_RADIUS);
    assert_eq!(clusters[0].weight, 5.0);
    assert_eq!(clusters[1].weight, 3.0);
}

#[test]
fn hue_wheel_gives_five_colors_below_coverage() {
    // 16×16 个区域，每个区域一个色相
    let mut image = solid(64, 64, [0, 0, 0, 255]);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let index = (y / 4) * 16 + x / 4;
        let [r, g, b] = hsv_to_rgb(index as f32 * 360.0 / 256.0);
        *pixel = Rgba([r, g, b, 255]);
    }

    let result = palette_from_frames(std::iter::once(&image)).unwrap();

    assert_eq!(result.0.len(), MAX_COLORS, "{result:?}");
    let covered: u32 = result.0.iter().map(|c| u32::from(c.percent)).sum();
    assert!(covered < 95, "{result:?}");
    assert!(
        result
            .0
            .windows(2)
            .all(|pair| pair[0].percent >= pair[1].percent),
        "{result:?}"
    );
}

#[test]
fn fully_transparent_image_has_no_palette() {
    let image = solid(64, 64, [255, 0, 0, 0]);
    assert_eq!(palette_from_frames(std::iter::once(&image)), None);
}

#[test]
fn icon_on_transparent_background_gives_only_the_icon_color() {
    // 透明底的颜色通道故意填成绿色：不能混进结果
    let mut image = solid(256, 256, [0, 255, 0, 0]);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        // 边界不对齐区域：边上的区域只盖住一部分
        if (70..180).contains(&x) && (90..200).contains(&y) {
            *pixel = Rgba([255, 0, 0, 255]);
        }
    }
    let result = palette_from_frames(std::iter::once(&image)).unwrap();
    assert_eq!(result, palette(&[(RED, 100)]));
}

#[test]
fn same_input_gives_same_palette() {
    let mut seed = 42;
    let mut image = solid(160, 90, [0, 0, 0, 255]);
    for pixel in image.pixels_mut() {
        *pixel = Rgba([
            (noise(&mut seed) % 256) as u8,
            (noise(&mut seed) % 64) as u8,
            (noise(&mut seed) % 256) as u8,
            255,
        ]);
    }
    // 再叠几块大色块，让并列与排序都有机会出现
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        if x < 80 && y < 45 {
            *pixel = Rgba([255, 0, 0, 255]);
        } else if x >= 80 && y >= 45 {
            *pixel = Rgba([0, 0, 255, 255]);
        }
    }

    let first = palette_from_frames(std::iter::once(&image));
    let second = palette_from_frames(std::iter::once(&image));

    assert!(first.is_some());
    assert_eq!(first, second);
}

#[test]
fn frames_are_merged_before_clustering() {
    let red = solid(32, 32, [255, 0, 0, 255]);
    let blue = solid(64, 16, [0, 0, 255, 255]);
    let result = palette_from_frames([&red, &blue].into_iter()).unwrap();
    assert_eq!(result, palette(&[(BLUE, 50), (RED, 50)]));

    assert_eq!(palette_from_frames(std::iter::empty()), None);
}

#[test]
fn select_top_stops_at_coverage_and_keeps_percent_of_the_whole() {
    // 60% + 36% 已超过 95%，剩下的 4% 不取，也不摊给前两个（剩下的是灰，不够鲜艳，不占鲜艳色名额）
    let clusters = vec![
        cluster(WHITE, 36.0),
        cluster(RED, 60.0),
        cluster(0x808080, 4.0),
    ];
    assert_eq!(
        select_top(clusters, MERGE_RADIUS),
        Some(palette(&[(RED, 60), (WHITE, 36)]))
    );

    // 占比不到 0.5% 的颜色取到时至少记 1
    let mut clusters: Vec<Cell> = (0..4)
        .map(|index| Cell {
            color: srgb_to_oklab([RED, GREEN, BLUE, WHITE][index]),
            weight: 230.0,
        })
        .collect();
    // 再加 20 个各占 0.3% 的灰：前四个只盖住 94%，第五个取并列里 rgb 最小的
    for level in 0..20u32 {
        clusters.push(Cell {
            color: srgb_to_oklab((0x40 + level) * 0x010101),
            weight: 3.0,
        });
    }
    let result = select_top(clusters, MERGE_RADIUS).unwrap();
    assert_eq!(result.0.len(), 5);
    assert!(result.0[..4].iter().all(|color| color.percent == 23));
    assert_eq!(
        result.0[4],
        PaletteColor {
            rgb: 0x404040,
            percent: 1
        }
    );

    assert_eq!(select_top(Vec::new(), MERGE_RADIUS), None);
}

fn cluster(rgb: u32, weight: f32) -> Cell {
    Cell {
        color: srgb_to_oklab(rgb),
        weight,
    }
}

// ---------------------------------------------------------------------------
// 鲜艳色名额
// ---------------------------------------------------------------------------

#[test]
fn accent_is_appended_when_the_palette_is_not_full() {
    // 白 90% + 灰 6% 已超过 95%，按面积只取两个；剩下的红 4% 够鲜艳、离白和灰都远：追加在最后，
    // 百分比是它真实的面积
    let clusters = vec![
        cluster(WHITE, 90.0),
        cluster(0x808080, 6.0),
        cluster(RED, 4.0),
    ];
    assert_eq!(
        select_top(clusters, MERGE_RADIUS),
        Some(palette(&[(WHITE, 90), (0x808080, 6), (RED, 4)]))
    );
}

#[test]
fn accent_replaces_the_last_color_when_the_palette_is_full() {
    // 按面积取满 5 个灰（累计 96%）；红只占 4%，换掉末位 6% 的那个灰
    let clusters = vec![
        cluster(WHITE, 40.0),
        cluster(0xe0e0e0, 25.0),
        cluster(0xc0c0c0, 15.0),
        cluster(0xa0a0a0, 10.0),
        cluster(0x808080, 6.0),
        cluster(RED, 4.0),
    ];
    assert_eq!(
        select_top(clusters, MERGE_RADIUS),
        Some(palette(&[
            (WHITE, 40),
            (0xe0e0e0, 25),
            (0xc0c0c0, 15),
            (0xa0a0a0, 10),
            (RED, 4),
        ]))
    );
}

#[test]
fn accent_keeps_its_true_share_and_respects_the_minimum_area() {
    // 0.6%：够格，记为 1（百分比至少为 1）
    let clusters = vec![
        cluster(WHITE, 960.0),
        cluster(0x808080, 34.0),
        cluster(RED, 6.0),
    ];
    assert_eq!(
        select_top(clusters, MERGE_RADIUS),
        Some(palette(&[(WHITE, 96), (RED, 1)]))
    );
    // 0.4%：不到面积下限，不给名额
    let clusters = vec![
        cluster(WHITE, 960.0),
        cluster(0x808080, 36.0),
        cluster(RED, 4.0),
    ];
    assert_eq!(
        select_top(clusters, MERGE_RADIUS),
        Some(palette(&[(WHITE, 96)]))
    );
}

#[test]
fn accent_needs_a_vivid_color_more_vivid_than_the_kept_ones() {
    // 没选上的只有灰：彩度不够，不给名额
    let clusters = vec![cluster(WHITE, 90.0), cluster(0x808080, 10.0)];
    assert_eq!(
        select_top(clusters.clone(), MERGE_RADIUS),
        Some(palette(&[(WHITE, 90), (0x808080, 10)]))
    );
    let clusters = vec![cluster(WHITE, 96.0), cluster(0x808080, 4.0)];
    assert_eq!(
        select_top(clusters, MERGE_RADIUS),
        Some(palette(&[(WHITE, 96)]))
    );

    // 已选的红 0xc04040 彩度 0.164；候选蓝 0x4060c0 彩度 0.155，没有比它高出 0.02，不给名额；
    // 0x3050d0 彩度 0.200，给
    let base = || vec![cluster(0xc04040, 50.0), cluster(WHITE, 46.0)];
    let mut dull = base();
    dull.push(cluster(0x4060c0, 4.0));
    assert_eq!(
        select_top(dull, MERGE_RADIUS),
        Some(palette(&[(0xc04040, 50), (WHITE, 46)]))
    );
    let mut vivid = base();
    vivid.push(cluster(0x3050d0, 4.0));
    assert_eq!(
        select_top(vivid, MERGE_RADIUS),
        Some(palette(&[(0xc04040, 50), (WHITE, 46), (0x3050d0, 4)]))
    );

    // 几个都够格时取彩度最高的，不看面积：红占 2%、蓝只占 0.6%，纯蓝（0.313）比纯红（0.258）鲜艳
    let clusters = vec![
        cluster(WHITE, 960.0),
        cluster(RED, 20.0),
        cluster(0x808080, 14.0),
        cluster(BLUE, 6.0),
    ];
    assert_eq!(
        select_top(clusters, MERGE_RADIUS),
        Some(palette(&[(WHITE, 96), (BLUE, 1)]))
    );
}

#[test]
fn accent_must_be_two_radii_away_from_the_kept_colors() {
    // 纯红比已选的 0xc04040 鲜艳得多，但两者色差 0.102：
    // 半径 0.06 时不到两倍半径（0.12），不给名额；半径 0.03 时超过两倍半径（0.06），给
    let clusters = vec![
        cluster(0xc04040, 50.0),
        cluster(WHITE, 46.0),
        cluster(RED, 4.0),
    ];
    let diff = color_diff(srgb_to_oklab(0xc04040), srgb_to_oklab(RED));
    assert!(diff > 0.06 && diff < 0.12, "{diff}");
    assert_eq!(
        select_top(clusters.clone(), MERGE_RADIUS),
        Some(palette(&[(0xc04040, 50), (WHITE, 46)]))
    );
    assert_eq!(
        select_top(clusters, 0.03),
        Some(palette(&[(0xc04040, 50), (WHITE, 46), (RED, 4)]))
    );
}

#[test]
fn accent_does_not_change_vivid_images() {
    // 已经有纯色的色盘：没选上的颜色不会比它更鲜艳，色盘与只按面积选的相同
    let mut image = solid(64, 64, [255, 0, 0, 255]);
    for (x, _, pixel) in image.enumerate_pixels_mut() {
        if x >= 48 {
            *pixel = Rgba([255, 255, 255, 255]);
        }
    }
    assert_eq!(
        palette_from_frames(std::iter::once(&image)),
        Some(palette(&[(RED, 75), (WHITE, 25)]))
    );
}

// ---------------------------------------------------------------------------
// 按整张图定合并半径
// ---------------------------------------------------------------------------

/// 淡粉与薄荷色：彩度 0.028 / 0.023，色差 0.051——比合并半径的上限小、比淡色图的半径大。
const PASTEL_PINK: u32 = 0xf6dee4;
const PASTEL_MINT: u32 = 0xdef0e6;

fn pastel_halves() -> RgbaImage {
    let mut image = solid(64, 64, [0xf6, 0xde, 0xe4, 255]);
    for (x, _, pixel) in image.enumerate_pixels_mut() {
        if x >= 32 {
            *pixel = Rgba([0xde, 0xf0, 0xe6, 255]);
        }
    }
    image
}

#[test]
fn merge_radius_follows_the_mean_chroma_of_the_whole_image() {
    let grays: Vec<Cell> = (0..10).map(|_| cluster(0x808080, 1.0)).collect();
    assert!((merge_radius_for(&grays) - 0.03).abs() < 1e-6);
    let reds: Vec<Cell> = (0..10).map(|_| cluster(RED, 1.0)).collect();
    assert_eq!(merge_radius_for(&reds), MERGE_RADIUS);
    // 均值 0.035 落在 0.02→0.05 的正中：半径也在 0.03→0.06 的正中
    let middle: Vec<Cell> = (0..4).map(|_| cell(0.7, 0.035, 0.0)).collect();
    assert!((merge_radius_for(&middle) - 0.045).abs() < 1e-5);
    // 按权重平均：一个权重 3 的红比三个灰重
    let mut weighted: Vec<Cell> = (0..3).map(|_| cluster(0x808080, 1.0)).collect();
    weighted.push(cluster(RED, 3.0));
    assert_eq!(merge_radius_for(&weighted), MERGE_RADIUS);
    assert_eq!(merge_radius_for(&[]), MERGE_RADIUS);

    let diff = color_diff(srgb_to_oklab(PASTEL_PINK), srgb_to_oklab(PASTEL_MINT));
    let cells = sample_cells(&pastel_halves());
    let radius = merge_radius_for(&cells);
    assert!(radius < diff && diff < MERGE_RADIUS, "{radius} {diff}");
}

#[test]
fn pale_image_keeps_its_pastel_tones_apart() {
    // 用上限半径时淡粉与薄荷色会并成一个颜色；按这张图的平均彩度定的半径更小，两色分开
    let cells = sample_cells(&pastel_halves());
    assert_eq!(
        select_top(
            remerge(merge_cells(cells, MERGE_RADIUS), MERGE_RADIUS),
            MERGE_RADIUS
        )
        .unwrap()
        .0
        .len(),
        1
    );

    let result = palette_from_frames(std::iter::once(&pastel_halves())).unwrap();

    assert_eq!(result, palette(&[(PASTEL_MINT, 50), (PASTEL_PINK, 50)]));
}

#[test]
fn multi_frame_radius_uses_all_frames_together() {
    // 淡色帧单独算时两色分开；和一帧纯红合在一起，平均彩度高，半径回到上限，淡粉与薄荷色并成一个
    let red = solid(64, 64, [255, 0, 0, 255]);
    let result = palette_from_frames([&pastel_halves(), &red].into_iter()).unwrap();

    assert_eq!(result.0.len(), 2, "{result:?}");
    assert_eq!(result.0[1].percent, 50);
    assert_eq!(result.0.iter().filter(|c| c.rgb == RED).count(), 1);
    let pastel = result.0.iter().find(|c| c.rgb != RED).unwrap();
    assert!(
        color_diff(srgb_to_oklab(pastel.rgb), srgb_to_oklab(PASTEL_PINK)) < 0.03
            && color_diff(srgb_to_oklab(pastel.rgb), srgb_to_oklab(PASTEL_MINT)) < 0.03,
        "{result:?}"
    );
}

// ---------------------------------------------------------------------------
// 再并
// ---------------------------------------------------------------------------

#[test]
fn remerge_joins_clusters_with_close_averages() {
    // 均匀渐变被聚合切成 121 / 61 / 59 三段（见 gradient_four_radii_wide_is_cut_from_its_densest_points）。
    // 后两段的平均色相距 60 步 = 0.0594，不到半径：并成一个，颜色是两者按权重的平均（第 60.5 步）；
    // 它离第一段 120.5 步，不再并。
    let merged = remerge(merge_cells(wide_gradient(), MERGE_RADIUS), MERGE_RADIUS);

    assert_eq!(merged.len(), 2, "{merged:?}");
    assert_eq!(merged[0].weight, 121.0);
    assert!(
        (merged[0].color.a + 60.0 * 0.00099).abs() < 1e-5,
        "{merged:?}"
    );
    assert_eq!(merged[1].weight, 120.0);
    assert!(
        (merged[1].color.a - 60.5 * 0.00099).abs() < 1e-5,
        "{merged:?}"
    );
    assert!((merged[1].color.l - 0.6).abs() < 1e-6 && merged[1].color.b.abs() < 1e-6);
}

#[test]
fn remerge_weights_the_average_and_keeps_the_lower_slot() {
    let clusters = vec![
        cell(0.6, 0.20, 0.0),
        Cell {
            color: Oklab {
                l: 0.5,
                a: 0.00,
                b: 0.10,
            },
            weight: 30.0,
        },
        Cell {
            color: Oklab {
                l: 0.54,
                a: 0.04,
                b: 0.10,
            },
            weight: 10.0,
        },
    ];

    let merged = remerge(clusters, MERGE_RADIUS);

    assert_eq!(merged.len(), 2);
    // 没参与的聚合点原样留在原位
    assert_eq!(merged[0].color.a, 0.20);
    assert_eq!(merged[0].weight, 1.0);
    // 并出来的留在下标小的那个位置：权重相加，颜色按 30 : 10 平均
    assert_eq!(merged[1].weight, 40.0);
    assert!((merged[1].color.l - 0.51).abs() < 1e-6, "{merged:?}");
    assert!((merged[1].color.a - 0.01).abs() < 1e-6, "{merged:?}");
    assert!((merged[1].color.b - 0.10).abs() < 1e-6, "{merged:?}");
}

#[test]
fn remerge_leaves_clusters_at_least_a_radius_apart() {
    // 相距正好等于半径的不并（只并「不到半径」的）
    let exactly = vec![
        Cell {
            color: Oklab {
                l: 0.5,
                a: 0.0,
                b: 0.0,
            },
            weight: 3.0,
        },
        Cell {
            color: Oklab {
                l: 0.5,
                a: MERGE_RADIUS,
                b: 0.0,
            },
            weight: 2.0,
        },
    ];
    assert_eq!(color_diff(exactly[0].color, exactly[1].color), MERGE_RADIUS);
    assert_eq!(remerge(exactly, MERGE_RADIUS).len(), 2);

    let apart = vec![
        cell(0.6, 0.0, 0.0),
        cell(0.6, 0.061, 0.0),
        cell(0.6, 0.0, 0.2),
    ];
    assert_eq!(remerge(apart, MERGE_RADIUS).len(), 3);

    // 略小于半径的并
    let close = vec![cell(0.6, 0.0, 0.0), cell(0.6, 0.059, 0.0)];
    assert_eq!(remerge(close, MERGE_RADIUS).len(), 1);

    assert!(remerge(Vec::new(), MERGE_RADIUS).is_empty());
    assert_eq!(remerge(vec![cell(0.6, 0.0, 0.0)], MERGE_RADIUS).len(), 1);
}

#[test]
fn remerge_takes_the_closest_pair_first_and_chains() {
    // 四个点排成一线，间距 0.05、0.04、0.05：先并最近的中间一对（得到 a = 0.07），
    // 它离两端各 0.07，不再并。若按下标顺序先并前两个，结果会不同。
    let line = vec![
        cell(0.6, 0.00, 0.0),
        cell(0.6, 0.05, 0.0),
        cell(0.6, 0.09, 0.0),
        cell(0.6, 0.14, 0.0),
    ];
    let merged = remerge(line, MERGE_RADIUS);
    assert_eq!(merged.len(), 3, "{merged:?}");
    assert_eq!(merged[1].weight, 2.0);
    assert!((merged[1].color.a - 0.07).abs() < 1e-6, "{merged:?}");

    // 连锁：并出来的平均色又离第三个不到半径，接着并，最后盖住比半径宽的一段
    let chain = vec![
        cell(0.6, 0.00, 0.0),
        cell(0.6, 0.04, 0.0),
        cell(0.6, 0.075, 0.0),
    ];
    assert!(color_diff(chain[0].color, chain[2].color) > MERGE_RADIUS);
    let merged = remerge(chain, MERGE_RADIUS);
    assert_eq!(merged.len(), 1, "{merged:?}");
    assert_eq!(merged[0].weight, 3.0);
    assert!((merged[0].color.a - 0.115 / 3.0).abs() < 1e-6, "{merged:?}");

    // 并列取下标小的一对：三个点等间距 3/64（二进制里是精确值），(0,1) 与 (1,2) 一样近。
    // 先并 (0,1) 得到 3/128，它离第三个点 9/128 ≈ 0.070，不再并；若先并 (1,2) 会留下 0 与 9/128。
    let step = 3.0 / 64.0;
    let tie = vec![
        cell(0.5, 0.0, 0.0),
        cell(0.5, step, 0.0),
        cell(0.5, 2.0 * step, 0.0),
    ];
    assert_eq!(
        color_diff(tie[0].color, tie[1].color),
        color_diff(tie[1].color, tie[2].color)
    );
    let merged = remerge(tie, MERGE_RADIUS);
    assert_eq!(merged.len(), 2, "{merged:?}");
    assert_eq!(merged[0].color.a, step / 2.0);
    assert_eq!(merged[0].weight, 2.0);
    assert_eq!(merged[1].color.a, 2.0 * step);
}

#[test]
fn remerge_gives_the_same_result_for_the_same_input() {
    let mut seed = 11;
    let clusters: Vec<Cell> = (0..200)
        .map(|_| Cell {
            color: Oklab {
                l: 0.2 + (noise(&mut seed) % 600) as f32 / 1000.0,
                a: (noise(&mut seed) % 300) as f32 / 1000.0 - 0.15,
                b: (noise(&mut seed) % 300) as f32 / 1000.0 - 0.15,
            },
            weight: 1.0 + (noise(&mut seed) % 50) as f32,
        })
        .collect();
    let total: f32 = clusters.iter().map(|c| c.weight).sum();

    let first = remerge(clusters.clone(), MERGE_RADIUS);
    let second = remerge(clusters, MERGE_RADIUS);

    assert!(first.len() < 200 && !first.is_empty());
    assert_eq!(first.len(), second.len());
    for (x, y) in first.iter().zip(&second) {
        assert_eq!(x.color, y.color);
        assert_eq!(x.weight, y.weight);
    }
    // 权重守恒；并完之后没有相距不到半径的一对
    let merged_total: f32 = first.iter().map(|c| c.weight).sum();
    assert!(
        (merged_total - total).abs() < 1e-2,
        "{merged_total} vs {total}"
    );
    for (index, x) in first.iter().enumerate() {
        for y in &first[index + 1..] {
            assert!(color_diff(x.color, y.color) >= MERGE_RADIUS);
        }
    }
}

#[test]
fn shaded_block_gives_one_palette_color() {
    // 经整条流程：左边一大块略有明暗变化的同一种蓝，右边一条红。色盘里只有一个蓝和一个红。
    let mut image = solid(512, 512, [0, 0, 0, 255]);
    for (x, _, pixel) in image.enumerate_pixels_mut() {
        *pixel = if x < 384 {
            // 0x104090 → 0x5080d0 的横向渐变
            let t = x as f32 / 383.0;
            Rgba([
                (16.0 + 64.0 * t) as u8,
                (64.0 + 64.0 * t) as u8,
                (144.0 + 64.0 * t) as u8,
                255,
            ])
        } else {
            Rgba([255, 0, 0, 255])
        };
    }
    let result = palette_from_frames(std::iter::once(&image)).unwrap();

    assert_eq!(result.0.len(), 2, "{result:?}");
    assert_eq!(result.0[0].percent, 75);
    assert!(rgb_close(result.0[0].rgb, 0x3060b0, 10), "{result:?}");
    assert_eq!(
        result.0[1],
        PaletteColor {
            rgb: RED,
            percent: 25
        }
    );
}

// ---------------------------------------------------------------------------
// 采样
// ---------------------------------------------------------------------------

#[test]
fn cells_are_averaged_in_linear_light() {
    // 每个区域 2×2 像素、黑白各半：线性光下的平均是 0.5，对应 sRGB 的 188，而不是 128
    let mut image = solid(32, 32, [0, 0, 0, 255]);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        if (x + y) % 2 == 0 {
            *pixel = Rgba([255, 255, 255, 255]);
        }
    }
    let result = palette_from_frames(std::iter::once(&image)).unwrap();
    assert_eq!(result.0.len(), 1);
    assert!(rgb_close(result.0[0].rgb, 0xbcbcbc, 1), "{result:?}");
}

#[test]
fn cells_are_weighted_by_alpha() {
    // 每个区域 2×2 像素：一个不透明的红，三个全透明的蓝（平均 alpha 0.25，够得上参与）
    let mut image = solid(32, 32, [0, 0, 255, 0]);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        if x % 2 == 0 && y % 2 == 0 {
            *pixel = Rgba([255, 0, 0, 255]);
        }
    }
    let result = palette_from_frames(std::iter::once(&image)).unwrap();
    assert_eq!(result, palette(&[(RED, 100)]));
}

#[test]
fn nearly_transparent_cells_are_dropped() {
    // 平均 alpha 约 0.04，低于阈值
    let image = solid(64, 64, [255, 0, 0, 10]);
    assert!(sample_cells(&image).is_empty());

    let image = solid(64, 64, [255, 0, 0, 40]);
    assert_eq!(sample_cells(&image).len(), 256);
}

#[test]
fn sampling_handles_odd_and_tiny_sizes() {
    assert!(sample_cells(&RgbaImage::new(0, 0)).is_empty());

    // 比 16 像素还小：一部分区域是空的，其余每个区域一个像素
    let tiny = solid(5, 3, [10, 20, 30, 255]);
    assert_eq!(sample_cells(&tiny).len(), 15);
    assert_eq!(
        palette_from_frames(std::iter::once(&tiny)),
        Some(palette(&[(0x0a141e, 100)]))
    );

    // 宽高不是 16 的倍数：区域大小不一，但每个像素恰好属于一个区域
    let odd = solid(513, 37, [10, 20, 30, 255]);
    assert_eq!(sample_cells(&odd).len(), 256);

    // 比 512 大的图不另外缩，直接按区域平均
    let large = solid(1000, 700, [10, 20, 30, 255]);
    assert_eq!(sample_cells(&large).len(), 256);
}

// ---------------------------------------------------------------------------
// 色差
// ---------------------------------------------------------------------------

#[test]
fn oklab_round_trips_srgb() {
    for rgb in [
        0x000000, 0xffffff, RED, GREEN, BLUE, 0x808080, 0x5a7d4a, 0xff8000, 0x123456, 0xfedcba,
    ] {
        assert_eq!(oklab_to_srgb(srgb_to_oklab(rgb)), rgb, "{rgb:06x}");
    }
    let white = srgb_to_oklab(WHITE);
    assert!((white.l - 1.0).abs() < 1e-3 && white.a.abs() < 1e-3 && white.b.abs() < 1e-3);
    let black = srgb_to_oklab(0);
    assert!(black.l.abs() < 1e-6 && black.a.abs() < 1e-6 && black.b.abs() < 1e-6);
    // Ottosson 给的参考值：纯红 (0.628, 0.225, 0.126)
    let red = srgb_to_oklab(RED);
    assert!((red.l - 0.628).abs() < 1e-3, "{red:?}");
    assert!((red.a - 0.225).abs() < 1e-3, "{red:?}");
    assert!((red.b - 0.126).abs() < 1e-3, "{red:?}");
    // 高 8 位忽略
    assert_eq!(srgb_to_oklab(0xff12_3456), srgb_to_oklab(0x12_3456));
}

#[test]
fn color_diff_halves_the_lightness_difference() {
    let dark = Oklab {
        l: 0.2,
        a: 0.0,
        b: 0.0,
    };
    let light = Oklab {
        l: 0.8,
        a: 0.0,
        b: 0.0,
    };
    assert!((color_diff(dark, light) - 0.3).abs() < 1e-6);
    let shifted = Oklab {
        l: 0.2,
        a: 0.3,
        b: 0.4,
    };
    assert!((color_diff(dark, shifted) - 0.5).abs() < 1e-6);
    assert_eq!(color_diff(shifted, shifted), 0.0);
    assert_eq!(color_diff(dark, light), color_diff(light, dark));
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

#[test]
fn json_round_trips() {
    let value = palette(&[(RED, 62), (WHITE, 33), (0, 5)]);
    let text = value.to_json();
    assert_eq!(text, "[[16711680,62],[16777215,33],[0,5]]");
    assert_eq!(Palette::from_json(&text), Some(value));

    let single = Palette::single([0x12, 0x34, 0x56]);
    assert_eq!(single, palette(&[(0x123456, 100)]));
    assert_eq!(single.to_json(), "[[1193046,100]]");
    assert_eq!(Palette::from_json(" [ [1193046, 100] ] "), Some(single));
}

#[test]
fn from_json_rejects_bad_input() {
    for text in [
        "",
        "null",
        "[]",
        "{}",
        "not json",
        "[[16711680,62]",
        "[16711680,62]",
        "[[16711680]]",
        "[[16711680,62,1]]",
        "[[\"ff0000\",62]]",
        "[[16711680.5,62]]",
        "[[-1,62]]",
        // rgb 超出 24 位
        "[[16777216,62]]",
        // 百分比不在 1..=100
        "[[16711680,0]]",
        "[[16711680,101]]",
        "[[16711680,300]]",
    ] {
        assert_eq!(Palette::from_json(text), None, "{text}");
    }
}

// ---------------------------------------------------------------------------
// 距离
// ---------------------------------------------------------------------------

#[test]
fn distance_basic_properties() {
    // 同色为 0
    for rgb in [RED, GREEN, BLUE, WHITE, 0, 0x808080, 0x5a7d4a] {
        assert_eq!(distance_to(Some(&palette(&[(rgb, 100)])), rgb), 0);
    }
    // 没有色盘为 65536：比有色盘的最大值 65535 大 1
    assert_eq!(distance_to(None, RED), NO_PALETTE_DISTANCE);
    assert_eq!(NO_PALETTE_DISTANCE, 65536);
    assert_eq!(distance_to(Some(&Palette(Vec::new())), RED), 65536);
    // 红色图到红桶比到蓝桶近
    let red = palette(&[(RED, 100)]);
    assert!(distance_to(Some(&red), RED) < distance_to(Some(&red), BLUE));
    // 百分比加起来不是 100 时按实际总和归一
    assert_eq!(
        distance_to(Some(&palette(&[(RED, 30), (WHITE, 30)])), GREEN),
        distance_to(Some(&palette(&[(RED, 50), (WHITE, 50)])), GREEN)
    );
    // distance_to 只是 distance_to_lab 的外壳
    assert_eq!(
        distance_to(Some(&red), 0x3a7bd5),
        distance_to_lab(Some(&red), srgb_to_oklab(0x3a7bd5))
    );
    assert_eq!(distance_to_lab(None, srgb_to_oklab(RED)), 65536);
}

#[test]
fn distance_with_a_palette_never_exceeds_65535() {
    let corners = [
        0x000000, 0xffffff, RED, GREEN, BLUE, 0xffff00, 0x00ffff, 0xff00ff,
    ];
    let mut farthest = 0;
    for from in corners {
        for to in corners {
            let distance = distance_to(Some(&palette(&[(from, 100)])), to);
            assert!(distance <= 65535, "{from:06x} → {to:06x}: {distance}");
            farthest = farthest.max(distance);
        }
    }
    // 满量程 0.65 略大于色域内的最大色差（纯绿对品红），最远的一对落在满量程的九成以上
    assert!(farthest > 59_000, "{farthest}");
    assert_eq!(
        farthest,
        distance_to(Some(&palette(&[(GREEN, 100)])), 0xff00ff)
    );
}

#[test]
fn distance_matches_the_worked_examples() {
    // 02-storage.md 点 1 的算例表。本机上逐项相等；留 ±2（折合色差 0.00002）给不同平台
    // `cbrt` / `powf` 末位的差异。旧量程 0..=255 下允许的 ±1 相当于这里的 ±257，不再需要那么宽。
    const WORKED_EXAMPLE_TOLERANCE: i64 = 2;
    let red_on_white = palette(&[(WHITE, 70), (RED, 30)]);
    let cases: [(&str, Palette, u32, i64); 5] = [
        ("红 → 红", palette(&[(RED, 100)]), RED, 0),
        ("红 30% 白 70% → 红", red_on_white.clone(), RED, 22430),
        ("红 30% 白 70% → 白", red_on_white, WHITE, 9613),
        ("深绿 → 纯绿", palette(&[(0x5a7d4a, 100)]), GREEN, 26525),
        ("白 → 纯绿", palette(&[(WHITE, 100)]), GREEN, 30478),
    ];
    for (name, value, bucket, expected) in cases {
        let distance = i64::from(distance_to(Some(&value), bucket));
        assert!(
            (distance - expected).abs() <= WORKED_EXAMPLE_TOLERANCE,
            "{name}: {distance}, expected {expected}"
        );
    }
    // 明度折半的依据：深绿色图比白色图更接近纯绿
    assert!(
        distance_to(Some(&palette(&[(0x5a7d4a, 100)])), GREEN)
            < distance_to(Some(&palette(&[(WHITE, 100)])), GREEN)
    );
}

#[test]
fn builtin_buckets_stay_apart() {
    // 基本色桶两两之间的色差都要超过合并半径的两倍，否则两个色桶的纯色可能落进同一个聚合点。
    // 最近的是红与橙、青与灰（都是 0.126），调大半径或再改色桶颜色时要重看。
    let mut closest = (f32::MAX, "", "");
    for (index, (first_key, first)) in REPORT_BUCKETS.iter().enumerate() {
        for (second_key, second) in &REPORT_BUCKETS[index + 1..] {
            let diff = color_diff(srgb_to_oklab(*first), srgb_to_oklab(*second));
            if diff < closest.0 {
                closest = (diff, first_key, second_key);
            }
        }
    }
    assert!(closest.0 > MERGE_RADIUS * 2.0, "{closest:?}");
    let red_orange = color_diff(srgb_to_oklab(RED), srgb_to_oklab(0xff8000));
    assert!(red_orange > MERGE_RADIUS * 2.0, "{red_orange}");
}

// ---------------------------------------------------------------------------
// 来源
// ---------------------------------------------------------------------------

fn still(path: &str) -> Option<PaletteSource> {
    Some(PaletteSource::Still(PathBuf::from(path)))
}

fn video(path: &str, fallback: Option<&str>) -> Option<PaletteSource> {
    Some(PaletteSource::Video {
        video: PathBuf::from(path),
        fallback: fallback.map(PathBuf::from),
    })
}

#[test]
fn source_for_images() {
    // 其它图片：缩略图；缺失时用原图
    assert_eq!(
        source_for_row("image/jpg", "/a/pic.jpg", "/t/pic.jpg", None, None),
        still("/t/pic.jpg")
    );
    assert_eq!(
        source_for_row("image/png", "/a/pic.png", "", None, None),
        still("/a/pic.png")
    );
    assert_eq!(
        source_for_row("image/png", "/a/pic.png", "/a/pic.png", None, None),
        still("/a/pic.png")
    );
    // 标准 MIME 也认；兼容副本不参与
    assert_eq!(
        source_for_row(
            "image/jpeg",
            "/a/pic.jpg",
            "/t/pic.jpg",
            Some("/c/pic.jpg"),
            None
        ),
        still("/t/pic.jpg")
    );
    // GIF：原文件抽帧
    assert_eq!(
        source_for_row("image/gif", "/a/anim.gif", "/t/anim.jpg", None, None),
        Some(PaletteSource::Animated(PathBuf::from("/a/anim.gif")))
    );
    assert_eq!(
        source_for_row(" IMAGE/GIF ", "", "/t/anim.jpg", None, None),
        still("/t/anim.jpg")
    );
    // 什么路径都没有
    assert_eq!(source_for_row("image/jpg", "", "  ", None, None), None);
    // 图片行不看 scheme_color
    assert_eq!(
        source_for_row("image/jpg", "/a/pic.jpg", "", None, Some([1, 2, 3])),
        still("/a/pic.jpg")
    );
}

#[test]
fn source_for_videos() {
    assert_eq!(
        source_for_row("video/mp4", "/a/clip.mp4", "/t/clip.mp4", None, None),
        video("/a/clip.mp4", Some("/t/clip.mp4"))
    );
    assert_eq!(
        source_for_row("video/mov", "/a/clip.mov", "", None, None),
        video("/a/clip.mov", None)
    );
    // 预览就是原视频：不重复当后备
    assert_eq!(
        source_for_row("video/webm", "/a/clip.webm", "/a/clip.webm", None, None),
        video("/a/clip.webm", None)
    );
    // Android：原视频是 content://，预览是 GIF
    assert_eq!(
        source_for_row(
            "video/mp4",
            "content://media/external/video/media/7",
            "/t/clip.gif",
            None,
            None
        ),
        video(
            "content://media/external/video/media/7",
            Some("/t/clip.gif")
        )
    );
    // 没有原视频路径：只剩预览文件，按扩展名读
    assert_eq!(
        source_for_row("video/mp4", "", "/t/clip.gif", None, None),
        Some(PaletteSource::Animated(PathBuf::from("/t/clip.gif")))
    );
    assert_eq!(
        source_for_row("video/mp4", "", "/t/clip.mp4", None, None),
        video("/t/clip.mp4", None)
    );
}

#[test]
fn source_for_wpe_rows() {
    let dir = "/steam/workshop/431960/123";
    // 视频壁纸：兼容路径抽帧，退到预览图；不看 scheme_color，也不读目录
    assert_eq!(
        source_for_row(
            "x-wpe/video",
            dir,
            "/steam/workshop/431960/123/preview.jpg",
            Some("/steam/workshop/431960/123/entry.mp4"),
            Some([1, 2, 3]),
        ),
        video(
            "/steam/workshop/431960/123/entry.mp4",
            Some("/steam/workshop/431960/123/preview.jpg")
        )
    );
    assert_eq!(
        source_for_row("x-wpe/video", dir, "/p/preview.gif", None, None),
        Some(PaletteSource::Animated(PathBuf::from("/p/preview.gif")))
    );
    assert_eq!(
        source_for_row("x-wpe/video", dir, "", Some(" "), None),
        None
    );
    // 网页 / 场景：schemecolor 优先
    for kind in ["x-wpe/web", "x-wpe/scene"] {
        assert_eq!(
            source_for_row(kind, dir, "/p/preview.jpg", None, Some([10, 20, 30])),
            Some(PaletteSource::Fixed([10, 20, 30]))
        );
        assert_eq!(
            source_for_row(kind, dir, "/p/preview.jpg", None, None),
            still("/p/preview.jpg")
        );
        assert_eq!(
            source_for_row(kind, dir, "/p/preview.gif", None, None),
            Some(PaletteSource::Animated(PathBuf::from("/p/preview.gif")))
        );
        // 连预览图都没有：没有来源（目录本身不能当文件读）
        assert_eq!(source_for_row(kind, dir, "", None, None), None);
    }
}

// ---------------------------------------------------------------------------
// compute：读真实文件
// ---------------------------------------------------------------------------

fn write_gif(path: &Path, frames: &[[u8; 4]]) {
    use image::codecs::gif::GifEncoder;
    let file = std::fs::File::create(path).unwrap();
    let mut encoder = GifEncoder::new(file);
    for color in frames {
        encoder
            .encode_frame(image::Frame::new(solid(32, 32, *color)))
            .unwrap();
    }
}

#[test]
fn compute_fixed_color() {
    assert_eq!(
        compute(&PaletteSource::Fixed([255, 128, 0])),
        Some(palette(&[(0xff8000, 100)]))
    );
}

#[test]
fn compute_still_image() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pic.png");
    solid(40, 30, [0, 0, 255, 255]).save(&path).unwrap();

    assert_eq!(
        compute(&PaletteSource::Still(path)),
        Some(palette(&[(BLUE, 100)]))
    );
    assert_eq!(
        compute(&PaletteSource::Still(dir.path().join("missing.png"))),
        None
    );

    // 扩展名与内容不符：按内容解
    let disguised = dir.path().join("really-a-png.jpg");
    solid(40, 30, [255, 0, 0, 255])
        .save_with_format(&disguised, image::ImageFormat::Png)
        .unwrap();
    assert_eq!(
        compute(&PaletteSource::Still(disguised)),
        Some(palette(&[(RED, 100)]))
    );

    let garbage = dir.path().join("garbage.png");
    std::fs::write(&garbage, b"not an image").unwrap();
    assert_eq!(compute(&PaletteSource::Still(garbage)), None);
}

#[test]
fn compute_gif_uses_all_frames() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("two.gif");
    write_gif(&path, &[[255, 0, 0, 255], [0, 0, 255, 255]]);

    // 缩略图只有第一帧（红），抽帧能看到蓝
    assert_eq!(
        compute(&PaletteSource::Animated(path)),
        Some(palette(&[(BLUE, 50), (RED, 50)]))
    );
}

#[test]
fn compute_long_gif_samples_evenly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("long.gif");
    // 100 帧：前 3/4 红，后 1/4 蓝。留帧的步长要翻几次倍，最后均匀取 8 帧：6 红 2 蓝
    let frames: Vec<[u8; 4]> = (0..100)
        .map(|index| {
            if index < 75 {
                [255, 0, 0, 255]
            } else {
                [0, 0, 255, 255]
            }
        })
        .collect();
    write_gif(&path, &frames);

    let cells = sample_gif_cells(&path).unwrap();
    assert_eq!(cells.len(), FRAME_SAMPLES * 256);
    assert_eq!(
        compute(&PaletteSource::Animated(path)),
        Some(palette(&[(RED, 75), (BLUE, 25)]))
    );
}

#[test]
fn compute_animated_falls_back_to_still_decoding() {
    let dir = tempfile::tempdir().unwrap();
    // 类型写的是 GIF，内容其实是 PNG
    let path = dir.path().join("fake.gif");
    solid(40, 30, [0, 255, 0, 255])
        .save_with_format(&path, image::ImageFormat::Png)
        .unwrap();
    assert_eq!(
        compute(&PaletteSource::Animated(path)),
        Some(palette(&[(GREEN, 100)]))
    );
    assert_eq!(
        compute(&PaletteSource::Animated(dir.path().join("missing.gif"))),
        None
    );
}

#[test]
fn compute_video_samples_the_whole_duration() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("clip.mp4");
    // 4 秒的灰度视频，从暗到亮
    crate::media::decode::tests::write_test_video(&path, 40, 10, 5);

    let result = compute(&PaletteSource::Video {
        video: path,
        fallback: None,
    })
    .unwrap();

    // 只看第一帧的话只有一个暗色；抽帧后有明有暗
    assert!(result.0.len() > 1, "{result:?}");
    let lightness: Vec<f32> = result.0.iter().map(|c| srgb_to_oklab(c.rgb).l).collect();
    let darkest = lightness.iter().copied().fold(f32::MAX, f32::min);
    let brightest = lightness.iter().copied().fold(f32::MIN, f32::max);
    assert!(brightest - darkest > 0.3, "{result:?}");
}

#[test]
fn compute_video_falls_back_to_the_preview_file() {
    let dir = tempfile::tempdir().unwrap();
    let preview = dir.path().join("preview.gif");
    write_gif(&preview, &[[0, 0, 255, 255]]);
    let missing = dir.path().join("missing.mp4");

    assert_eq!(
        compute(&PaletteSource::Video {
            video: missing.clone(),
            fallback: Some(preview),
        }),
        Some(palette(&[(BLUE, 100)]))
    );
    assert_eq!(
        compute(&PaletteSource::Video {
            video: missing.clone(),
            fallback: None,
        }),
        None
    );
    assert_eq!(
        compute(&PaletteSource::Video {
            video: missing,
            fallback: Some(dir.path().join("missing.jpg")),
        }),
        None
    );
}

#[tokio::test]
async fn compute_for_row_reads_the_thumbnail() {
    let dir = tempfile::tempdir().unwrap();
    let thumbnail = dir.path().join("thumb.png");
    solid(40, 30, [255, 0, 0, 255]).save(&thumbnail).unwrap();
    let thumbnail = thumbnail.to_str().unwrap();

    assert_eq!(
        compute_for_row("image/jpg", "/nowhere/original.jpg", thumbnail, None, None).await,
        Some(palette(&[(RED, 100)]))
    );
    // WPE 网页壁纸：有 schemecolor 时不读盘
    assert_eq!(
        compute_for_row(
            "x-wpe/web",
            "/nowhere/dir",
            thumbnail,
            None,
            Some([0, 0, 255])
        )
        .await,
        Some(palette(&[(BLUE, 100)]))
    );
    assert_eq!(
        compute_for_row("x-wpe/scene", "/nowhere/dir", thumbnail, None, None).await,
        Some(palette(&[(RED, 100)]))
    );
    // 没有来源、文件不存在：None，不报错
    assert_eq!(
        compute_for_row("x-wpe/web", "/nowhere/dir", "", None, None).await,
        None
    );
    assert_eq!(
        compute_for_row("image/jpg", "/nowhere/original.jpg", "", None, None).await,
        None
    );
}

// ---------------------------------------------------------------------------
// 调常量用的对照页（06-verification.md 点 2）
// ---------------------------------------------------------------------------

// 对照页用的色桶：正式的 12 个基本色桶 `(名称键, 0xRRGGBB)`。
use crate::storage::migrations::BUILTIN_COLOR_BUCKETS as REPORT_BUCKETS;

/// 每个色桶看最近与最远各多少张。
const REPORT_PER_SIDE: usize = 50;
/// 「只有一个颜色」「色盘里有相近的两个颜色」各看多少张。
const REPORT_SAMPLE: usize = 60;

struct ReportEntry {
    path: PathBuf,
    palette: Option<Palette>,
}

/// 色盘里最近的两个颜色的色差；不足两个颜色为 `None`。
fn closest_pair(palette: &Palette) -> Option<f32> {
    let colors: Vec<Oklab> = palette.0.iter().map(|c| srgb_to_oklab(c.rgb)).collect();
    let mut closest: Option<f32> = None;
    for (index, first) in colors.iter().enumerate() {
        for second in &colors[index + 1..] {
            let diff = color_diff(*first, *second);
            closest = Some(closest.map_or(diff, |current| current.min(diff)));
        }
    }
    closest
}

fn report_tile(entry: &ReportEntry, caption: &str) -> String {
    let url = url::Url::from_file_path(&entry.path)
        .map(|url| url.to_string())
        .unwrap_or_default();
    let media = match source_for_file(&entry.path) {
        PaletteSource::Video { .. } => {
            format!(r#"<video muted preload="metadata" src="{url}"></video>"#)
        }
        _ => format!(r#"<img loading="lazy" src="{url}">"#),
    };
    let mut bar = String::new();
    let mut legend = String::new();
    for color in entry.palette.iter().flat_map(|palette| palette.0.iter()) {
        bar.push_str(&format!(
            r##"<i style="flex:{} 0 0;background:#{:06x}" title="#{:06x} {}%"></i>"##,
            color.percent, color.rgb, color.rgb, color.percent
        ));
        legend.push_str(&format!("#{:06x} {}% ", color.rgb, color.percent));
    }
    let name = entry
        .path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!(
        r#"<figure>{media}<div class="bar">{bar}</div><figcaption><b>{caption}</b> {legend}<br><small>{name}</small></figcaption></figure>"#
    )
}

/// 对照页要看的文件：目录下（不递归）格式表认识的扩展名，按文件名排序；`limit` 给出时均匀抽这么多个。
/// 返回（要算的文件，目录里一共找到多少个）。
fn report_paths(input: &Path, limit: Option<usize>) -> (Vec<PathBuf>, usize) {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(input)
        .expect("read KABEGAME_PALETTE_REPORT_DIR")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_file())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .and_then(image_type::media_format_by_ext)
                .is_some()
        })
        .collect();
    paths.sort();
    let found = paths.len();
    if let Some(limit) = limit.filter(|limit| *limit < found) {
        paths = (0..limit)
            .map(|index| paths[index * found / limit].clone())
            .collect();
    }
    (paths, found)
}

/// `report.tsv`：每张图一行（路径、色盘、色盘里最近两色的色差、到各色桶的距离）。`entries` 都有色盘。
fn report_tsv(entries: &[ReportEntry], buckets: &[(&str, u32)]) -> String {
    use std::fmt::Write as _;

    let mut tsv = String::from("path\tpalette\tclosest_pair");
    for (name, _) in buckets {
        write!(tsv, "\t{name}").unwrap();
    }
    tsv.push('\n');
    for entry in entries {
        let palette = entry.palette.as_ref().unwrap();
        write!(
            tsv,
            "{}\t{}\t{}",
            entry.path.display(),
            palette.to_json(),
            closest_pair(palette).map_or(String::new(), |diff| format!("{diff:.4}"))
        )
        .unwrap();
        for (_, rgb) in buckets {
            write!(tsv, "\t{}", distance_to(Some(palette), *rgb)).unwrap();
        }
        tsv.push('\n');
    }
    tsv
}

/// `index.html`：每个色桶最近 / 最远各 [`REPORT_PER_SIDE`] 张，外加「只有一个颜色」与
/// 「色盘里有相近的两个颜色」两组。`intro` 是页头的说明（已是 HTML）。`entries` 都有色盘。
fn report_html(
    title: &str,
    intro: &str,
    entries: &[ReportEntry],
    buckets: &[(&str, u32)],
) -> String {
    use std::fmt::Write as _;

    let mut size_histogram = [0usize; MAX_COLORS + 1];
    for entry in entries {
        size_histogram[entry.palette.as_ref().unwrap().0.len()] += 1;
    }

    let mut html = String::new();
    write!(
        html,
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{title}</title><style>
body{{font:13px/1.4 system-ui,sans-serif;margin:16px;background:#1e1e1e;color:#ddd}}
h2{{margin:28px 0 8px;display:flex;align-items:center;gap:8px}}
h3{{margin:14px 0 6px;font-weight:normal;color:#aaa}}
.chip{{display:inline-block;width:22px;height:22px;border:1px solid #888;border-radius:4px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}}
figure{{margin:0;background:#2a2a2a;border-radius:4px;overflow:hidden}}
figure img,figure video{{display:block;width:100%;height:100px;object-fit:cover;background:#000}}
.bar{{display:flex;height:14px;border-top:1px solid #000}}
figcaption{{padding:3px 5px;font-size:11px;word-break:break-all}}
small{{color:#888}}
nav a{{color:#8cf;margin-right:10px}}
table{{border-collapse:collapse}}td,th{{border:1px solid #555;padding:2px 8px;text-align:right}}
</style></head><body><h1>{title}</h1>{intro}"#
    )
    .unwrap();
    html.push_str("<table><tr><th>色盘颜色数</th>");
    for size in 1..=MAX_COLORS {
        write!(html, "<th>{size}</th>").unwrap();
    }
    html.push_str("</tr><tr><td>张数</td>");
    for size in 1..=MAX_COLORS {
        write!(html, "<td>{}</td>", size_histogram[size]).unwrap();
    }
    html.push_str("</tr></table><nav><p>");
    for (index, (name, _)) in buckets.iter().enumerate() {
        write!(html, r##"<a href="#bucket-{index}">{name}</a>"##).unwrap();
    }
    html.push_str(
        r##"<a href="#single">只有一个颜色</a><a href="#close">相近的两个颜色</a></p></nav>"##,
    );

    for (index, (name, rgb)) in buckets.iter().enumerate() {
        let mut ranked: Vec<(u32, &ReportEntry)> = entries
            .iter()
            .map(|entry| (distance_to(entry.palette.as_ref(), *rgb), entry))
            .collect();
        ranked.sort_by(|x, y| x.0.cmp(&y.0).then_with(|| x.1.path.cmp(&y.1.path)));
        write!(
            html,
            r#"<h2 id="bucket-{index}"><span class="chip" style="background:#{rgb:06x}"></span>{name} #{rgb:06x}</h2>"#
        )
        .unwrap();
        let near = ranked.len().min(REPORT_PER_SIDE);
        write!(html, r#"<h3>最近的 {near} 张</h3><div class="grid">"#).unwrap();
        for (distance, entry) in &ranked[..near] {
            html.push_str(&report_tile(entry, &format!("距离 {distance}")));
        }
        html.push_str("</div>");
        let far = ranked.len().saturating_sub(near).min(REPORT_PER_SIDE);
        write!(html, r#"<h3>最远的 {far} 张</h3><div class="grid">"#).unwrap();
        for (distance, entry) in ranked[ranked.len() - far..].iter().rev() {
            html.push_str(&report_tile(entry, &format!("距离 {distance}")));
        }
        html.push_str("</div>");
    }

    let single: Vec<&ReportEntry> = entries
        .iter()
        .filter(|entry| entry.palette.as_ref().unwrap().0.len() == 1)
        .collect();
    let shown = single.len().min(REPORT_SAMPLE);
    write!(
        html,
        r#"<h2 id="single">只有一个颜色（共 {} 张，均匀抽 {shown} 张）</h2><div class="grid">"#,
        single.len(),
    )
    .unwrap();
    for slot in 0..shown {
        html.push_str(&report_tile(single[slot * single.len() / shown], "1 色"));
    }
    html.push_str("</div>");

    let mut close: Vec<(f32, &ReportEntry)> = entries
        .iter()
        .filter_map(|entry| Some((closest_pair(entry.palette.as_ref()?)?, entry)))
        .collect();
    close.sort_by(|x, y| x.0.total_cmp(&y.0).then_with(|| x.1.path.cmp(&y.1.path)));
    write!(
        html,
        r#"<h2 id="close">色盘里最近的两个颜色（色差最小的 {} 张；合并半径 {MERGE_RADIUS}）</h2><div class="grid">"#,
        close.len().min(REPORT_SAMPLE)
    )
    .unwrap();
    for (diff, entry) in close.iter().take(REPORT_SAMPLE) {
        html.push_str(&report_tile(entry, &format!("色差 {diff:.3}")));
    }
    html.push_str("</div></body></html>");
    html
}

/// 读 `KABEGAME_PALETTE_REPORT_DIR` / `_OUT` / `_LIMIT`。目录没给时返回 `None`。
fn report_env() -> Option<(PathBuf, PathBuf, Option<usize>)> {
    let input = std::env::var_os("KABEGAME_PALETTE_REPORT_DIR").map(PathBuf::from)?;
    let output = std::env::var_os("KABEGAME_PALETTE_REPORT_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("kabegame-palette-report"));
    let limit = std::env::var("KABEGAME_PALETTE_REPORT_LIMIT")
        .ok()
        .and_then(|text| text.parse::<usize>().ok())
        .filter(|limit| *limit > 0);
    Some((input, output, limit))
}

/// 调常量用：对一个目录的图片算色盘，按每个基本色桶的距离排序，输出 HTML 对照页。
///
/// ```text
/// KABEGAME_PALETTE_REPORT_DIR=<图片目录>            必填，不递归
/// KABEGAME_PALETTE_REPORT_OUT=<输出目录>            可选，默认系统临时目录下的 kabegame-palette-report
/// KABEGAME_PALETTE_REPORT_LIMIT=<张数>              可选，均匀抽这么多张
/// .claude/skills/test-kabegame/driver.sh kabegame-core --lib palette_report -- --ignored --nocapture
/// ```
///
/// 产出 `index.html`（缩略图 + 色盘色块 + 距离）与 `report.tsv`（每张图的色盘与 12 个距离）。
#[test]
#[ignore = "调常量用的对照页，需要 KABEGAME_PALETTE_REPORT_DIR"]
fn palette_report() {
    use std::fmt::Write as _;

    let Some((input, output, limit)) = report_env() else {
        println!("palette_report: KABEGAME_PALETTE_REPORT_DIR 未设置，跳过");
        return;
    };
    let (paths, found) = report_paths(&input, limit);

    let started = std::time::Instant::now();
    let workers = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .min(paths.len().max(1));
    let mut entries: Vec<ReportEntry> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|worker| {
                let paths = &paths;
                scope.spawn(move || {
                    paths
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| index % workers == worker)
                        .map(|(index, path)| {
                            let entry = ReportEntry {
                                path: path.clone(),
                                palette: compute(&source_for_file(path)),
                            };
                            (index, entry)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut indexed: Vec<(usize, ReportEntry)> = handles
            .into_iter()
            .flat_map(|handle| handle.join().expect("palette worker"))
            .collect();
        indexed.sort_by_key(|(index, _)| *index);
        indexed.into_iter().map(|(_, entry)| entry).collect()
    });
    let elapsed = started.elapsed();

    let without: Vec<String> = entries
        .iter()
        .filter(|entry| entry.palette.is_none())
        .map(|entry| entry.path.display().to_string())
        .collect();
    entries.retain(|entry| entry.palette.is_some());
    let mut size_histogram = [0usize; MAX_COLORS + 1];
    for entry in &entries {
        size_histogram[entry.palette.as_ref().unwrap().0.len()] += 1;
    }

    std::fs::create_dir_all(&output).expect("create report dir");
    std::fs::write(
        output.join("report.tsv"),
        report_tsv(&entries, &REPORT_BUCKETS),
    )
    .expect("write report.tsv");

    let mut intro = String::new();
    write!(
        intro,
        "<p>目录：{}<br>找到 {found} 个媒体文件，计算 {} 个，耗时 {:.1} 秒（{workers} 线程）；\
         有色盘 {}，没有色盘 {}。</p>",
        input.display(),
        paths.len(),
        elapsed.as_secs_f64(),
        entries.len(),
        without.len(),
    )
    .unwrap();
    write!(
        intro,
        "<p>常量：MERGE_RADIUS = {MERGE_RADIUS}，LIGHTNESS_WEIGHT = {LIGHTNESS_WEIGHT}，\
         DISTANCE_FULL_SCALE = {DISTANCE_FULL_SCALE}，MAX_COLORS = {MAX_COLORS}，COVERAGE = {COVERAGE}，\
         GRID = {GRID}。</p>"
    )
    .unwrap();
    if !without.is_empty() {
        write!(
            intro,
            "<p>没有色盘（共 {} 个，列前 20 个）：",
            without.len()
        )
        .unwrap();
        for path in without.iter().take(20) {
            write!(intro, "<br>{path}").unwrap();
        }
        intro.push_str("</p>");
    }
    let index = output.join("index.html");
    std::fs::write(
        &index,
        report_html("色盘对照页", &intro, &entries, &REPORT_BUCKETS),
    )
    .expect("write index.html");

    println!(
        "palette_report: {} 张有色盘，{} 张没有，耗时 {:.1} 秒",
        entries.len(),
        without.len(),
        elapsed.as_secs_f64()
    );
    println!(
        "palette_report: 颜色数分布 1..={MAX_COLORS} = {:?}",
        &size_histogram[1..]
    );
    println!("palette_report: {}", index.display());
}
