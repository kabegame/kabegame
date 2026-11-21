//! 真总线测试：在会话总线上起假播放器（[`super::fixture`]），看 [`LinuxWatch`] 推出的读数。要有会话总线，手动跑：
//! `cargo test -p tauri-plugin-sysmedia --features mpris-fixture -- --ignored`。本机别的播放器在播时会抢走当前会话，
//! 先停掉它们。

use super::fixture::{FakePlayer, Track};
use super::*;
use crate::models::{MediaSnapshot, PlaybackStatus};
use crate::MediaEvent;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self as std_mpsc, Receiver};

const WAIT: Duration = Duration::from_secs(5);

fn suffix(tag: &str) -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    format!(
        "kabegame_test_{}_{}_{tag}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    )
}

fn start_watch() -> (LinuxWatch, Receiver<MediaEvent>) {
    let (sender, receiver) = std_mpsc::channel();
    // 假播放器与测试同进程：不排除本进程
    let watch = LinuxWatch::start_with(
        Box::new(move |event| {
            let _ = sender.send(event);
        }),
        None,
    );
    (watch, receiver)
}

/// 等到第一条满足 `pred` 的读数；超时把收到过的都打出来。
fn wait_for(
    receiver: &Receiver<MediaEvent>,
    what: &str,
    pred: impl Fn(&MediaEvent) -> bool,
) -> MediaEvent {
    let deadline = Instant::now() + WAIT;
    let mut seen = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(left) {
            Ok(event) if pred(&event) => return event,
            Ok(event) => seen.push(event),
            Err(_) => panic!("等不到 {what}，收到过: {seen:#?}"),
        }
    }
}

fn session_title(event: &MediaEvent) -> Option<&str> {
    match event {
        MediaEvent::Session(Some(MediaSnapshot {
            properties: Some(p),
            ..
        })) => Some(p.title.as_str()),
        _ => None,
    }
}

fn track(id: u32, title: &str, art_url: &str) -> Track {
    Track {
        id,
        title: title.to_string(),
        artists: vec!["Kabegame".to_string(), "Fixture".to_string()],
        album: "Tests".to_string(),
        length_micros: 180_000_000,
        art_url: art_url.to_string(),
    }
}

#[test]
#[ignore = "要会话总线，手动跑"]
fn follows_fake_players_over_the_session_bus() {
    let (watch, events) = start_watch();
    wait_for(&events, "第一次会话", |e| {
        matches!(e, MediaEvent::Session(_))
    });

    let a = FakePlayer::start(
        &suffix("a"),
        "kabegame-fixture",
        track(1, "Alpha", "data:image/png;base64,TU0AKg=="),
        "Playing",
    )
    .unwrap();
    let event = wait_for(&events, "Alpha 成为当前会话", |e| {
        session_title(e) == Some("Alpha")
    });
    let MediaEvent::Session(Some(snapshot)) = event else {
        unreachable!()
    };
    let props = snapshot.properties.unwrap();
    assert_eq!(props.app_id, "kabegame-fixture");
    assert_eq!(props.artist, "Kabegame, Fixture");
    assert_eq!(props.album_title, "Tests");
    assert_eq!(props.thumbnail.as_deref(), Some(&b"MM\0*"[..]));
    assert_eq!(snapshot.playback, PlaybackStatus::Playing);
    let timeline = snapshot.timeline.unwrap();
    assert_eq!(timeline.end_micros, 180_000_000);
    assert!(timeline.updated_unix_micros > 0, "读到了 Position");

    // 暂停：推播放状态，位置重读
    a.set_position(12_000_000).unwrap();
    a.set_status("Paused").unwrap();
    wait_for(&events, "暂停", |e| {
        *e == MediaEvent::Playback(PlaybackStatus::Paused)
    });
    wait_for(
        &events,
        "暂停后重读的位置",
        |e| matches!(e, MediaEvent::Timeline(Some(t)) if t.position_micros == 12_000_000),
    );

    // 换曲：推属性
    a.set_track(track(2, "Beta", "")).unwrap();
    wait_for(
        &events,
        "换曲",
        |e| matches!(e, MediaEvent::Properties(Some(p)) if p.title == "Beta" && p.thumbnail.is_none()),
    );

    // 跳转：信号里的位置
    a.seek(42_000_000).unwrap();
    wait_for(
        &events,
        "跳转",
        |e| matches!(e, MediaEvent::Timeline(Some(t)) if t.position_micros == 42_000_000),
    );

    // 第二个播放器。和 A 同一进程（测试进程），按会话身份（进程）是同一个会话：它接手时推属性等变化、不推换会话。
    // 不同进程之间换会话由 mpris.rs 的纯逻辑单测覆盖。
    // 没播过的暂停播放器不抢当前会话
    let b = FakePlayer::start(&suffix("b"), "", track(3, "Gamma", ""), "Paused").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    while let Ok(event) = events.try_recv() {
        assert!(
            !matches!(&event, MediaEvent::Properties(Some(p)) if p.title == "Gamma"),
            "暂停的新播放器抢了会话: {event:?}"
        );
    }
    // 它开始播放才接手
    b.set_status("Playing").unwrap();
    let event = wait_for(
        &events,
        "Gamma 接手",
        |e| matches!(e, MediaEvent::Properties(Some(p)) if p.title == "Gamma"),
    );
    let MediaEvent::Properties(Some(p)) = &event else {
        unreachable!()
    };
    // 没有 DesktopEntry：取总线名去掉前缀
    assert!(p.app_id.starts_with("kabegame_test_"), "{}", p.app_id);
    wait_for(&events, "Gamma 在播", |e| {
        *e == MediaEvent::Playback(PlaybackStatus::Playing)
    });

    // B 退出：回到 A（暂停中、最近播过）
    drop(b);
    wait_for(
        &events,
        "回到 Beta",
        |e| matches!(e, MediaEvent::Properties(Some(p)) if p.title == "Beta"),
    );
    // A 退出：没有会话（本机没有别的播放器时）或换到别的播放器
    drop(a);
    wait_for(&events, "A 退出后换会话", |e| {
        matches!(e, MediaEvent::Session(_)) && session_title(e) != Some("Beta")
    });
    drop(watch);
}

/// 一个只回一次的 http 服务器，返回地址。
fn serve_once(body: Vec<u8>) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut request = [0u8; 2048];
            let _ = std::io::Read::read(&mut stream, &mut request);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    format!("http://{address}/cover.jpg")
}

#[test]
#[ignore = "要会话总线，手动跑"]
fn artwork_from_file_and_http_arrives_with_the_title() {
    let dir = std::env::temp_dir().join(format!("kabegame-sysmedia-art-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("封面 1.jpg");
    std::fs::write(&file, b"file cover bytes").unwrap();
    let file_url = format!(
        "file://{}",
        percent_encoding::utf8_percent_encode(
            file.to_str().unwrap(),
            percent_encoding::NON_ALPHANUMERIC
        )
        .to_string()
        .replace("%2F", "/")
    );

    let (watch, events) = start_watch();
    wait_for(&events, "第一次会话", |e| {
        matches!(e, MediaEvent::Session(_))
    });
    let player = FakePlayer::start(
        &suffix("art"),
        "",
        track(1, "FileArt", &file_url),
        "Playing",
    )
    .unwrap();
    let event = wait_for(&events, "file 封面", |e| {
        session_title(e) == Some("FileArt")
    });
    let MediaEvent::Session(Some(MediaSnapshot {
        properties: Some(p),
        ..
    })) = event
    else {
        unreachable!()
    };
    assert_eq!(p.thumbnail.as_deref(), Some(&b"file cover bytes"[..]));

    // http：标题与封面在同一条读数里到
    let url = serve_once(b"http cover bytes".to_vec());
    player.set_track(track(2, "HttpArt", &url)).unwrap();
    let event = wait_for(
        &events,
        "http 封面",
        |e| matches!(e, MediaEvent::Properties(Some(p)) if p.title == "HttpArt"),
    );
    let MediaEvent::Properties(Some(p)) = event else {
        unreachable!()
    };
    assert_eq!(p.thumbnail.as_deref(), Some(&b"http cover bytes"[..]));

    // 取不到的 http 封面：等到失败后照样推标题，封面为空
    player
        .set_track(track(3, "DeadArt", "http://127.0.0.1:9/none.jpg"))
        .unwrap();
    let event = wait_for(
        &events,
        "取不到的封面",
        |e| matches!(e, MediaEvent::Properties(Some(p)) if p.title == "DeadArt"),
    );
    assert!(matches!(event, MediaEvent::Properties(Some(p)) if p.thumbnail.is_none()));

    drop(player);
    drop(watch);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 真机：打印本机当前的 MPRIS 会话与之后 `KABEGAME_SYSMEDIA_SECS`（缺省 5）秒内的读数（封面只打长度）。
/// 排除本进程照常生效，看的是别的播放器。
#[test]
#[ignore = "读本机的 MPRIS，手动跑"]
fn prints_this_machines_session() {
    let (sender, receiver) = std_mpsc::channel();
    let watch = LinuxWatch::start(Box::new(move |event| {
        let _ = sender.send(event);
    }));
    let secs = std::env::var("KABEGAME_SYSMEDIA_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let started = Instant::now();
    let deadline = started + Duration::from_secs(secs);
    while let Ok(mut event) =
        receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
    {
        if let MediaEvent::Session(Some(MediaSnapshot {
            properties: Some(p),
            ..
        }))
        | MediaEvent::Properties(Some(p)) = &mut event
        {
            if let Some(bytes) = p.thumbnail.take() {
                println!(
                    "  (thumbnail {} bytes, head {:02x?})",
                    bytes.len(),
                    &bytes[..bytes.len().min(8)]
                );
            }
        }
        println!("{:>6} ms {event:?}", started.elapsed().as_millis());
    }
    drop(watch);
}

#[test]
fn loopback_urls_are_detected() {
    assert!(is_loopback("http://127.0.0.1:8080/a.jpg"));
    assert!(is_loopback("http://localhost/a.jpg"));
    assert!(is_loopback("http://[::1]:80/a.jpg"));
    assert!(!is_loopback("https://i.scdn.co/image/ab67"));
    assert!(!is_loopback("not a url"));
}

#[test]
fn reads_are_capped() {
    assert_eq!(read_capped(&b"abc"[..]), Some(b"abc".to_vec()));
    assert_eq!(read_capped(&b""[..]), None);
    let big = std::io::repeat(0).take(ART_MAX_BYTES + 1);
    assert_eq!(read_capped(big), None);
}
