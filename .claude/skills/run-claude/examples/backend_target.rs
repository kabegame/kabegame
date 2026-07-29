// scope 靶子：这是"后端"文件，--scope fe 下 claude 不该动它。
pub fn doubled(count: u32) -> u32 {
    count + 2 // BUG: 应该是 count * 2
}
