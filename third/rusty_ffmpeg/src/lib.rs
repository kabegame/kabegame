mod avutil;

// Force recompilation when the externally-built FFmpeg static archives change.
// The value is emitted by build.rs and becomes part of this crate's compiled input.
#[allow(dead_code)]
const FFMPEG_ARCHIVE_STAMP: Option<&str> = option_env!("RUSTY_FFMPEG_ARCHIVE_STAMP");

#[allow(
    non_snake_case,
    non_camel_case_types,
    non_upper_case_globals,
    improper_ctypes,
    unnecessary_transmutes,
    clippy::all
)]
pub mod ffi {
    #[cfg(feature = "ffmpeg6")]
    pub use crate::avutil::channel_layout::*;
    pub use crate::avutil::{_avutil::*, common::*, error::*, pixfmt::*, rational::*};
    include!(concat!(env!("OUT_DIR"), "/binding.rs"));
}
