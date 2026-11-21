//! 假的 MPRIS 播放器，供 dev 走查 Linux 的媒体集成（同 Windows 的 SMTC 夹具）。
//!
//! ```bash
//! cargo run -p tauri-plugin-sysmedia --features mpris-fixture --example mpris_fixture
//! ```
//!
//! 起来后以 `org.mpris.MediaPlayer2.kabegame_fixture`（`DesktopEntry` 为 `kabegame-fixture`）在播，从标准输入逐行读命令：
//!
//! | 命令 | 作用 |
//! | --- | --- |
//! | `title <文字>` / `artist <甲, 乙>` / `album <文字>` / `art <地址>` / `length <秒>` | 换曲目（曲目 id 加一、位置归零） |
//! | `play` / `pause` / `stop` | 播放状态 |
//! | `pos <秒>` | 只改位置，不发信号 |
//! | `seek <秒>` | 改位置并发 `Seeked` |
//! | `rate <倍数>` | 速率 |
//! | `quit` | 退出（总线上随之消失） |
//!
//! 后台跑时可以让它读一个文件的追加内容：`tail -f cmds.txt | cargo run …`，再 `echo pause >> cmds.txt`。

#[cfg(target_os = "linux")]
fn main() {
    use std::io::BufRead;
    use tauri_plugin_sysmedia::mpris_fixture::{FakePlayer, Track};

    let mut track = Track {
        id: 1,
        title: "Kabegame Fixture".to_string(),
        artists: vec!["Kabegame".to_string()],
        album: "MPRIS".to_string(),
        length_micros: 200_000_000,
        art_url: String::new(),
    };
    let player = match FakePlayer::start(
        "kabegame_fixture",
        "kabegame-fixture",
        track.clone(),
        "Playing",
    ) {
        Ok(player) => player,
        Err(error) => {
            eprintln!("起不来（会话总线？名字被占？）: {error}");
            std::process::exit(1);
        }
    };
    println!("ready {}", player.name);
    let seconds = |text: &str| text.trim().parse::<f64>().map(|s| (s * 1e6) as i64);
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let line = line.trim();
        let (command, argument) = line.split_once(' ').unwrap_or((line, ""));
        let argument = argument.trim();
        let mut new_track = |change: &mut dyn FnMut(&mut Track)| {
            change(&mut track);
            track.id += 1;
            player.set_track(track.clone())
        };
        let result = match command {
            "" => continue,
            "title" => new_track(&mut |t| t.title = argument.to_string()),
            "artist" => new_track(&mut |t| {
                t.artists = argument.split(',').map(|a| a.trim().to_string()).collect()
            }),
            "album" => new_track(&mut |t| t.album = argument.to_string()),
            "art" => new_track(&mut |t| t.art_url = argument.to_string()),
            "length" => match seconds(argument) {
                Ok(micros) => new_track(&mut |t| t.length_micros = micros),
                Err(error) => Err(zbus::Error::Failure(error.to_string())),
            },
            "play" => player.set_status("Playing"),
            "pause" => player.set_status("Paused"),
            "stop" => player.set_status("Stopped"),
            "pos" => seconds(argument)
                .map_err(|error| zbus::Error::Failure(error.to_string()))
                .and_then(|micros| player.set_position(micros)),
            "seek" => seconds(argument)
                .map_err(|error| zbus::Error::Failure(error.to_string()))
                .and_then(|micros| player.seek(micros)),
            "rate" => argument
                .parse::<f64>()
                .map_err(|error| zbus::Error::Failure(error.to_string()))
                .and_then(|rate| player.set_rate(rate)),
            "quit" => break,
            other => Err(zbus::Error::Failure(format!("不认识的命令: {other}"))),
        };
        match result {
            Ok(()) => println!("ok {line}"),
            Err(error) => println!("error {line}: {error}"),
        }
    }
    println!("bye");
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("mpris_fixture 只在 Linux 上有");
}
