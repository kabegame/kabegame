/// XHH (小黑盒) 签名计算模块
///
/// 实现 items-api.md §3 描述的 nonce + hkey 生成算法，
/// 用于构建 api.xiaoheihe.cn 签名请求。

const CHARSET: &str = "AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89";

/// 生成 nonce：MD5(t.to_string() + pseudo_random).to_uppercase()
///
/// `t` 为 Unix 秒。使用 SystemTime 纳秒作为伪随机源（格式化为 "0.{nanos}"，与 JS Math.random() 形式相仿）。
pub fn xhh_nonce(t: i64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let raw = format!("{}0.{}", t, nanos);
    format!("{:X}", md5::compute(raw.as_bytes()))
}

/// 路径规范化：URL 或路径 → /bbs/app/feeds/
pub fn normalize_path(url_or_path: &str) -> String {
    let trimmed = url_or_path.trim();
    let path_only = if trimmed.contains("://") {
        // 取 pathname
        trimmed
            .find("://")
            .and_then(|i| {
                let after_scheme = &trimmed[i + 3..];
                // 找到第一个 / 后的部分（或整个剩余作为 /）
                after_scheme.find('/').map(|j| &after_scheme[j..])
            })
            .unwrap_or("/")
    } else {
        trimmed
    };
    // 去除 query string
    let path_only = path_only
        .find('?')
        .map(|i| &path_only[..i])
        .unwrap_or(path_only);
    let segs: Vec<&str> = path_only.split('/').filter(|s| !s.is_empty()).collect();
    format!("/{}/", segs.join("/"))
}

/// 将字符串的每个字符映射到 charset 子集（charset[0..charset_len]）
/// charset_len 为 None 时使用全部 charset
fn map_string_with_charset(s: &str, charset_len: usize) -> String {
    let pool: Vec<char> = CHARSET.chars().take(charset_len).collect();
    let len = pool.len();
    s.chars().map(|c| pool[(c as usize) % len]).collect()
}

/// Galois field helpers（与 JS Vm/qm/$m/Ym/Gm 等价）
#[inline]
fn gf_vm(e: u32) -> u32 {
    if e & 128 != 0 {
        255 & ((e << 1) ^ 27)
    } else {
        e << 1
    }
}
#[inline]
fn gf_qm(e: u32) -> u32 {
    gf_vm(e) ^ e
}
#[inline]
fn gf_sm(e: u32) -> u32 {
    gf_qm(gf_vm(e))
}
#[inline]
fn gf_ym(e: u32) -> u32 {
    gf_sm(gf_qm(gf_vm(e)))
}
#[inline]
fn gf_gm(e: u32) -> u32 {
    gf_ym(e) ^ gf_sm(e) ^ gf_qm(e)
}

/// 对 last6Codes 的前 4 字节应用 Galois field 混合（in-place）
fn mix_four_bytes_in_place(e: &mut [u32]) {
    let t0 = gf_gm(e[0]) ^ gf_ym(e[1]) ^ gf_sm(e[2]) ^ gf_qm(e[3]);
    let t1 = gf_qm(e[0]) ^ gf_gm(e[1]) ^ gf_ym(e[2]) ^ gf_sm(e[3]);
    let t2 = gf_sm(e[0]) ^ gf_qm(e[1]) ^ gf_gm(e[2]) ^ gf_ym(e[3]);
    let t3 = gf_ym(e[0]) ^ gf_sm(e[1]) ^ gf_qm(e[2]) ^ gf_gm(e[3]);
    e[0] = t0;
    e[1] = t1;
    e[2] = t2;
    e[3] = t3;
}

/// 列交错（column-major zip）：partA[0]+partB[0]+partC[0], partA[1]+...
fn interleave_column_major(parts: &[&str]) -> String {
    let max_len = parts.iter().map(|s| s.len()).max().unwrap_or(0);
    let chars: Vec<Vec<char>> = parts.iter().map(|s| s.chars().collect()).collect();
    let mut out = String::new();
    for r in 0..max_len {
        for part in &chars {
            if r < part.len() {
                out.push(part[r]);
            }
        }
    }
    out
}

/// 计算 hkey（items-api.md §3.3 六步算法）
pub fn xhh_hkey(path: &str, t: i64, nonce: &str) -> String {
    let path_norm = normalize_path(path);
    let t_inner = t + 1;

    // partA: map string(t+1) with CHARSET[0..-2] (34 chars)
    let part_a = map_string_with_charset(&t_inner.to_string(), CHARSET.len() - 2);
    // partB: map normalized path with full CHARSET (36 chars)
    let part_b = map_string_with_charset(&path_norm, CHARSET.len());
    // partC: map nonce with full CHARSET (36 chars)
    let part_c = map_string_with_charset(nonce, CHARSET.len());

    // Interleave column-major, take first 20 chars
    let interleaved: String = interleave_column_major(&[&part_a, &part_b, &part_c])
        .chars()
        .take(20)
        .collect();

    // MD5 of interleaved string
    let md5hex = format!("{:x}", md5::compute(interleaved.as_bytes()));

    // Last 6 chars → ASCII codes
    let last6_chars: Vec<char> = md5hex
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let mut last6_codes: Vec<u32> = last6_chars.iter().map(|&c| c as u32).collect();

    // Mix first 4 bytes in place
    mix_four_bytes_in_place(&mut last6_codes);

    // Sum all 6 codes mod 100 → two-digit string
    let sum: u32 = last6_codes.iter().sum();
    let two_digit = format!("{:02}", sum % 100);

    // Prefix: first 5 chars of md5hex, mapped with CHARSET[0..-4] (32 chars)
    let prefix = map_string_with_charset(&md5hex[..5], CHARSET.len() - 4);

    format!("{}{}", prefix, two_digit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_path() {
        assert_eq!(normalize_path("/bbs/app/feeds"), "/bbs/app/feeds/");
        assert_eq!(
            normalize_path("https://api.xiaoheihe.cn/bbs/app/feeds?foo=bar"),
            "/bbs/app/feeds/"
        );
        assert_eq!(normalize_path("/bbs/app/link/tree"), "/bbs/app/link/tree/");
    }

    #[test]
    fn test_hkey_length() {
        // hkey should be 7 chars: 5 prefix + 2 digit
        let h = xhh_hkey(
            "/bbs/app/api/general/search/v1",
            1700000000,
            "ABCDEF1234567890ABCDEF1234567890",
        );
        assert_eq!(h.len(), 7, "hkey length should be 7, got: {}", h);
    }

    #[test]
    fn test_nonce_format() {
        let n = xhh_nonce(1700000000);
        assert_eq!(n.len(), 32);
        assert!(
            n.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_lowercase()),
            "nonce should be uppercase hex: {}",
            n
        );
    }
}
