//! Steam 内容的解密、解压与 JWT 声明读取。照 SteamKit2 `CryptoHelper.SymmetricDecrypt`、`VZipUtil`、
//! `VZstdUtil`、`ZipUtil`。

use std::io::{Cursor, Read};

use aes::cipher::{generic_array::GenericArray, BlockDecrypt, KeyInit};
use aes::Aes256;
use base64::prelude::{BASE64_STANDARD, BASE64_URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::Value;
use sha1::{Digest, Sha1};

/// Steam 的对称解密：前 16 字节是用 ECB 加密的 IV，其余是 AES-256-CBC + PKCS7。
pub fn symmetric_decrypt(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 32 || data.len() % 16 != 0 {
        return Err(format!("密文长度不对：{}", data.len()));
    }
    let cipher = Aes256::new_from_slice(key).map_err(|_| "depot 密钥不是 32 字节".to_string())?;
    let mut iv = GenericArray::clone_from_slice(&data[..16]);
    cipher.decrypt_block(&mut iv);
    let mut prev: [u8; 16] = iv.into();
    let mut out = Vec::with_capacity(data.len() - 16);
    for block in data[16..].chunks_exact(16) {
        let mut b = GenericArray::clone_from_slice(block);
        cipher.decrypt_block(&mut b);
        out.extend(b.iter().zip(prev.iter()).map(|(x, p)| x ^ p));
        prev.copy_from_slice(block);
    }
    let pad = *out.last().ok_or("空明文")? as usize;
    if pad == 0 || pad > 16 || out.len() < pad || !out[out.len() - pad..].iter().all(|&b| b as usize == pad) {
        return Err("PKCS7 填充不对".to_string());
    }
    out.truncate(out.len() - pad);
    Ok(out)
}

/// manifest 里加密的文件名：base64（每 72 字符带换行，照 .NET 忽略空白）→ 解密 → 去掉结尾的 NUL。
pub fn decrypt_filename(key: &[u8], encoded: &str) -> Result<String, String> {
    let compact: String = encoded.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let encrypted = BASE64_STANDARD
        .decode(compact)
        .map_err(|e| format!("文件名 base64 解码失败：{e}"))?;
    let plain = symmetric_decrypt(key, &encrypted)?;
    Ok(String::from_utf8_lossy(&plain).trim_end_matches('\0').to_string())
}

/// chunk 解密后的三种封装：VZip（LZMA）、VSZa（zstd）、PK（zip 单条目）。返回原始数据。
pub fn decompress_chunk(data: &[u8], expected_len: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(expected_len);
    if data.starts_with(b"VZa") {
        // 头 7 字节：'V' 'Z' 'a' + u32；然后 5 字节 LZMA 属性；尾 10 字节：u32 crc、u32 原始大小、"zv"
        if data.len() < 22 || !data.ends_with(b"zv") {
            return Err("VZip 头尾不完整".to_string());
        }
        let props = data[7];
        let dict = u32::from_le_bytes(data[8..12].try_into().unwrap());
        let body = &data[12..data.len() - 10];
        let mut reader =
            lzma_rust2::LzmaReader::new_with_props(Cursor::new(body), expected_len as u64, props, dict, None)
                .map_err(|e| format!("LZMA 初始化失败：{e}"))?;
        reader
            .read_to_end(&mut out)
            .map_err(|e| format!("LZMA 解压失败：{e}"))?;
    } else if data.starts_with(b"VSZa") {
        // 头 8 字节："VSZa" + u32 crc，之后是一个 zstd 帧，帧后是尾部（解码器读完一帧即停）
        let mut source = &data[8..];
        let mut decoder = ruzstd::decoding::StreamingDecoder::new(&mut source)
            .map_err(|e| format!("zstd 初始化失败：{e}"))?;
        decoder
            .read_to_end(&mut out)
            .map_err(|e| format!("zstd 解压失败：{e}"))?;
    } else if data.starts_with(b"PK\x03\x04") {
        let mut archive = zip::ZipArchive::new(Cursor::new(data)).map_err(|e| format!("zip 打开失败：{e}"))?;
        let mut entry = archive.by_index(0).map_err(|e| format!("zip 条目读取失败：{e}"))?;
        entry.read_to_end(&mut out).map_err(|e| format!("zip 解压失败：{e}"))?;
    } else {
        return Err(format!("未知的 chunk 封装：{:02x?}", &data[..data.len().min(4)]));
    }
    if out.len() != expected_len {
        return Err(format!("chunk 解压后 {} 字节，应为 {expected_len}", out.len()));
    }
    Ok(out)
}

pub fn sha1(data: &[u8]) -> [u8; 20] {
    Sha1::digest(data).into()
}

/// 只读 JWT 的声明部分（不验签），用于取 `sub` / `exp` / `aud`。
pub fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = BASE64_URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncrypt;

    /// 照 SteamKit2 `SymmetricEncrypt` 造密文：随机 IV 用 ECB 加密放在前面，正文 CBC + PKCS7。
    fn encrypt(key: &[u8], plain: &[u8], iv: [u8; 16]) -> Vec<u8> {
        let cipher = Aes256::new_from_slice(key).unwrap();
        let mut enc_iv = GenericArray::clone_from_slice(&iv);
        cipher.encrypt_block(&mut enc_iv);
        let pad = 16 - plain.len() % 16;
        let mut padded = plain.to_vec();
        padded.extend(std::iter::repeat(pad as u8).take(pad));
        let mut out = enc_iv.to_vec();
        let mut prev = iv;
        for block in padded.chunks(16) {
            let mut b = GenericArray::clone_from_slice(block);
            for (x, p) in b.iter_mut().zip(prev.iter()) {
                *x ^= p;
            }
            cipher.encrypt_block(&mut b);
            prev.copy_from_slice(&b);
            out.extend_from_slice(&b);
        }
        out
    }

    #[test]
    fn symmetric_roundtrip() {
        let key = [7u8; 32];
        for len in [0usize, 1, 15, 16, 17, 100] {
            let plain: Vec<u8> = (0..len as u8).collect();
            let data = encrypt(&key, &plain, [3u8; 16]);
            assert_eq!(symmetric_decrypt(&key, &data).unwrap(), plain);
        }
    }

    /// 错误密钥不一定被填充检查发现（约 1/256 的概率末字节恰好是 0x01），真正的保护是 chunk 解压后的 SHA-1；
    /// 这里只测确定能拒绝的情况：长度不对、密钥长度不对。
    #[test]
    fn malformed_input_is_rejected() {
        let data = encrypt(&[7u8; 32], b"hello", [3u8; 16]);
        assert!(symmetric_decrypt(&[7u8; 32], &data[..20]).is_err());
        assert!(symmetric_decrypt(&[7u8; 32], &data[..16]).is_err());
        assert!(symmetric_decrypt(&[7u8; 16], &data).is_err());
    }

    #[test]
    fn filename_base64_with_line_breaks() {
        let key = [9u8; 32];
        let name = "assets\\shaders\\common.h\0";
        let encoded = BASE64_STANDARD.encode(encrypt(&key, name.as_bytes(), [1u8; 16]));
        // 模拟 manifest 里每 72 字符一个换行
        let wrapped: String = encoded
            .as_bytes()
            .chunks(8)
            .map(|c| format!("{}\n", std::str::from_utf8(c).unwrap()))
            .collect();
        assert_eq!(decrypt_filename(&key, &wrapped).unwrap(), "assets\\shaders\\common.h");
    }

    #[test]
    fn zip_chunk_and_length_check() {
        use std::io::Write;
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            zip.start_file("z", zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(b"chunk-data").unwrap();
            zip.finish().unwrap();
        }
        let data = buf.into_inner();
        assert_eq!(decompress_chunk(&data, 10).unwrap(), b"chunk-data");
        assert!(decompress_chunk(&data, 11).is_err());
        assert!(decompress_chunk(b"????", 1).is_err());
    }

    #[test]
    fn vzip_lzma_chunk() {
        use lzma_rust2::{LzmaOptions, LzmaWriter};
        use std::io::Write;
        let plain: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let options = LzmaOptions::with_preset(6);
        // 原始 LZMA 流（无 .lzma 头），属性与字典大小写进 VZip 头
        let mut raw = Vec::new();
        {
            let mut writer = LzmaWriter::new_no_header(&mut raw, &options, false).unwrap();
            writer.write_all(&plain).unwrap();
            writer.finish().unwrap();
        }
        let mut data = b"VZa".to_vec();
        data.extend_from_slice(&0u32.to_le_bytes());
        data.push(options.get_props());
        data.extend_from_slice(&options.dict_size.to_le_bytes());
        data.extend_from_slice(&raw);
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&(plain.len() as u32).to_le_bytes());
        data.extend_from_slice(b"zv");
        assert_eq!(decompress_chunk(&data, plain.len()).unwrap(), plain);
    }

    #[test]
    fn jwt_claims_reads_payload() {
        let payload = BASE64_URL_SAFE_NO_PAD.encode(br#"{"sub":"7656","exp":123,"aud":["client"]}"#);
        let claims = jwt_claims(&format!("h.{payload}.s")).unwrap();
        assert_eq!(claims["sub"], "7656");
        assert_eq!(claims["exp"], 123);
        assert!(jwt_claims("not-a-jwt").is_none());
    }
}
