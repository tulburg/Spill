// The Spill app (S-36, D-22): one process holds a window per project. Each window shows its
// project's board, served by `spill serve` (bun), which the app starts on a free port and stops
// when the window closes. `spill app` hands its folder to a running app over a Unix socket, or
// starts the app with the folder in SPILL_OPEN. Recent projects live in ~/.spill/recent.
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const RECENT_SHOWN: usize = 10;

struct Project {
    label: String,
    root: PathBuf,
    name: String,
    port: u16,
    server: Child,
}

// S-45: a spec's design viewer in a window of its own, tied to its project's window.
struct DesignWin {
    label: String,
    project: String,
    spec: String,
}

#[derive(Default)]
struct Windows {
    open: Vec<Project>,
    designs: Vec<DesignWin>,
    focused: Option<String>,
    next: u32,
}

#[derive(Default)]
struct AppState(Mutex<Windows>);

fn spill_home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join(".spill")
}

fn socket_path() -> PathBuf {
    spill_home().join("app.sock")
}

// The folder holding a .spill board: `dir` itself or the nearest folder above it.
fn find_root(dir: &Path) -> Option<PathBuf> {
    let mut d = fs::canonicalize(dir).ok()?;
    loop {
        if d.join(".spill").is_dir() {
            return Some(d);
        }
        if !d.pop() {
            return None;
        }
    }
}

// The "project" field of .spill/config.json, or the folder name.
fn project_name(root: &Path) -> String {
    let fallback = || root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Spill".into());
    let Ok(text) = fs::read_to_string(root.join(".spill").join("config.json")) else { return fallback() };
    let Some(at) = text.find("\"project\"") else { return fallback() };
    let rest = &text[at + 9..];
    let Some(open) = rest.find('"') else { return fallback() };
    let value = &rest[open + 1..];
    match value.find('"') {
        Some(end) if end > 0 => value[..end].to_string(),
        _ => fallback(),
    }
}

// ~/.spill/recent: one "seconds<TAB>name<TAB>path" line per project, most recent first.
fn read_recent() -> Vec<(String, PathBuf)> {
    let text = fs::read_to_string(spill_home().join("recent")).unwrap_or_default();
    text.lines()
        .filter_map(|l| {
            let mut parts = l.splitn(3, '\t');
            let (_, name, path) = (parts.next()?, parts.next()?, parts.next()?);
            Some((name.to_string(), PathBuf::from(path)))
        })
        .collect()
}

fn write_recent(lines: &[String]) {
    let _ = fs::create_dir_all(spill_home());
    let _ = fs::write(spill_home().join("recent"), lines.iter().map(|l| format!("{l}\n")).collect::<String>());
}

fn touch_recent(root: &Path, name: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let text = fs::read_to_string(spill_home().join("recent")).unwrap_or_default();
    let path = root.to_string_lossy();
    let mut lines = vec![format!("{now}\t{name}\t{path}")];
    lines.extend(text.lines().filter(|l| l.splitn(3, '\t').nth(2) != Some(&*path)).take(49).map(String::from));
    write_recent(&lines);
}

fn alert(title: &str, message: &str) {
    let q = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let _ = Command::new("osascript").args(["-e", &format!("display alert \"{}\" message \"{}\"", q(title), q(message))]).status();
}

// A free port, or `want` when it is free.
// The bun that runs board servers. `spill app` passes its own (SPILL_BUN); an app opened from the
// Dock or Finder gets a minimal PATH without bun, so look where bun is usually installed.
fn bun_path() -> String {
    if let Ok(b) = std::env::var("SPILL_BUN") {
        return b;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    [format!("{home}/.bun/bin/bun"), "/opt/homebrew/bin/bun".into(), "/usr/local/bin/bun".into()]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
        .unwrap_or_else(|| "bun".into())
}

fn pick_port(want: Option<u16>) -> u16 {
    if let Some(p) = want {
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(4747)
}

fn focus_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Open the board for `dir` in a new window, or bring its window forward if it is already open.
fn open_project(app: &AppHandle, dir: &Path, port: Option<u16>) {
    let Some(root) = find_root(dir) else {
        alert("No Spill board here", &format!("{} has no .spill folder, in it or above it.", dir.display()));
        return;
    };
    let name = project_name(&root);
    let state = app.state::<AppState>();
    let open = state.0.lock().unwrap().open.iter().find(|p| p.root == root).map(|p| p.label.clone());
    if let Some(label) = open {
        touch_recent(&root, &name);
        focus_window(app, &label);
        refresh_menu(app);
        return;
    }

    let bun = bun_path();
    let cli = std::env::var("SPILL_CLI").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../src/cli.ts").into());
    let port = pick_port(port);
    let server = match Command::new(bun).arg(cli).arg("serve").arg(port.to_string()).current_dir(&root).stdout(Stdio::null()).spawn() {
        Ok(c) => c,
        Err(e) => {
            alert("Could not start the board", &format!("{}: {e}", root.display()));
            return;
        }
    };
    let label = {
        let mut w = state.0.lock().unwrap();
        w.next += 1;
        let label = format!("p{}", w.next);
        w.open.push(Project { label: label.clone(), root: root.clone(), name: name.clone(), port, server });
        label
    };
    touch_recent(&root, &name);

    // Wait for the server off the main thread, then open the window on it.
    let app = app.clone();
    thread::spawn(move || {
        let start = Instant::now();
        while TcpStream::connect(("127.0.0.1", port)).is_err() {
            if start.elapsed() > Duration::from_secs(15) {
                close_project(&app, &label);
                alert("Could not start the board", &format!("The board for {name} did not start on port {port}."));
                if app.webview_windows().is_empty() {
                    app.exit(1);
                }
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        // ?app tells the page it runs in the app, so design windows open natively (S-45).
        let url = format!("http://localhost:{port}/?app=1").parse().expect("board url");
        let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
            .title(format!("Spill: {name}"))
            .inner_size(1440.0, 960.0)
            .min_inner_size(900.0, 600.0);
        // The page's header doubles as the title bar; the traffic lights float over its left edge.
        #[cfg(target_os = "macos")]
        let window = window
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(18.0, 20.0));
        if let Err(e) = window.build() {
            close_project(&app, &label);
            alert("Could not open the window", &e.to_string());
            return;
        }
        refresh_menu(&app);
    });
}

// Stop a window's board server and forget the window. Its design windows close with it (S-45).
fn close_project(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    let mut w = state.0.lock().unwrap();
    let mut designs = Vec::new();
    if let Some(i) = w.open.iter().position(|p| p.label == label) {
        let mut p = w.open.remove(i);
        let _ = p.server.kill();
        let _ = p.server.wait();
        designs = w.designs.iter().filter(|d| d.project == label).map(|d| d.label.clone()).collect();
    }
    w.designs.retain(|d| d.label != label && d.project != label);
    if w.focused.as_deref() == Some(label) {
        w.focused = None;
    }
    drop(w);
    for d in designs {
        if let Some(win) = app.get_webview_window(&d) {
            let _ = win.close();
        }
    }
}

// S-45: open a spec's design window for the project at `root`, or bring it forward on the view asked for.
fn open_designs(app: &AppHandle, root: &Path, spec: &str, view: &str, id: &str, snap: &str) {
    let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let state = app.state::<AppState>();
    let Some((project, name, port)) = state.0.lock().unwrap().open.iter().find(|p| p.root == root).map(|p| (p.label.clone(), p.name.clone(), p.port)) else {
        return;
    };
    let label = format!("{project}-{spec}");
    if let Some(win) = app.get_webview_window(&label) {
        let js = format!("window.spillDesigns && window.spillDesigns({view:?}, {id:?}, {snap:?})");
        let _ = win.eval(&js);
        focus_window(app, &label);
        return;
    }
    let mut url = format!("http://localhost:{port}/?app=1&designs={spec}&view={view}");
    if !id.is_empty() {
        url += &format!("&id={id}");
    }
    if !snap.is_empty() {
        url += &format!("&snap={snap}");
    }
    let Ok(url) = url.parse() else { return };
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(format!("{spec} designs, {name}"))
        .inner_size(1280.0, 860.0)
        .min_inner_size(640.0, 420.0)
        .build();
    match built {
        Ok(_) => {
            state.0.lock().unwrap().designs.push(DesignWin { label, project, spec: spec.to_string() });
            refresh_menu(app);
        }
        Err(e) => alert("Could not open the designs", &e.to_string()),
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Spill",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &sep()?,
            &MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let recent = read_recent();
    let mut recent_items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
    for (i, (name, path)) in recent.iter().take(RECENT_SHOWN).enumerate() {
        // Two projects with one name are told apart by their folder.
        let dup = recent.iter().take(RECENT_SHOWN).filter(|(n, _)| n == name).count() > 1;
        let text = if dup { format!("{name} ({})", path.display()) } else { name.clone() };
        recent_items.push(Box::new(MenuItem::with_id(app, format!("recent:{i}"), text, true, None::<&str>)?));
    }
    recent_items.push(Box::new(sep()?));
    recent_items.push(Box::new(MenuItem::with_id(app, "clear-recent", "Clear Menu", !recent.is_empty(), None::<&str>)?));
    let recent_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = recent_items.iter().map(|b| b.as_ref()).collect();
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "open", "Open Project...", true, Some("CmdOrCtrl+O"))?,
            &Submenu::with_items(app, "Open Recent", true, &recent_refs)?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?, &sep()?, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    let state = app.state::<AppState>();
    let (windows, focused) = {
        let w = state.0.lock().unwrap();
        (w.open.iter().map(|p| (p.label.clone(), p.name.clone())).collect::<Vec<_>>(), w.focused.clone())
    };
    let mut window_items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> =
        vec![Box::new(PredefinedMenuItem::minimize(app, None)?), Box::new(PredefinedMenuItem::maximize(app, None)?)];
    if !windows.is_empty() {
        window_items.push(Box::new(sep()?));
    }
    let designs: Vec<(String, String, String)> = state.0.lock().unwrap().designs.iter().map(|d| (d.label.clone(), d.project.clone(), d.spec.clone())).collect();
    for (label, name) in &windows {
        let on = focused.as_deref() == Some(label.as_str());
        window_items.push(Box::new(CheckMenuItem::with_id(app, format!("win:{label}"), name, true, on, None::<&str>)?));
        // S-45: a project's design windows sit under it.
        for (dl, _, spec) in designs.iter().filter(|(_, p, _)| p == label) {
            let on = focused.as_deref() == Some(dl.as_str());
            window_items.push(Box::new(CheckMenuItem::with_id(app, format!("win:{dl}"), format!("    {spec} designs"), true, on, None::<&str>)?));
        }
    }
    let window_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = window_items.iter().map(|b| b.as_ref()).collect();
    let window_menu = Submenu::with_items(app, "Window", true, &window_refs)?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
}

fn refresh_menu(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(menu) = build_menu(&handle) {
            let _ = handle.set_menu(menu);
        }
    });
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => {
            let app = app.clone();
            thread::spawn(move || {
                let out = Command::new("osascript").args(["-e", "POSIX path of (choose folder with prompt \"Open a Spill project\")"]).output();
                if let Ok(o) = out {
                    let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if o.status.success() && !path.is_empty() {
                        open_project(&app, Path::new(&path), None);
                    }
                }
            });
        }
        "clear-recent" => {
            write_recent(&[]);
            refresh_menu(app);
        }
        "reload" => {
            let focused = app.state::<AppState>().0.lock().unwrap().focused.clone();
            if let Some(w) = focused.and_then(|l| app.get_webview_window(&l)) {
                let _ = w.eval("location.reload()");
            }
        }
        // S-39: the board UI owns the Settings panel; the menu just opens it in the focused window.
        "settings" => {
            let focused = app.state::<AppState>().0.lock().unwrap().focused.clone();
            if let Some(w) = focused.and_then(|l| app.get_webview_window(&l)) {
                let _ = w.eval("window.spillSettings && window.spillSettings()");
            }
        }
        _ => {
            if let Some(i) = id.strip_prefix("recent:").and_then(|i| i.parse::<usize>().ok()) {
                if let Some((_, path)) = read_recent().get(i).cloned() {
                    let app = app.clone();
                    thread::spawn(move || open_project(&app, &path, None));
                }
            } else if let Some(label) = id.strip_prefix("win:") {
                focus_window(app, label);
                // A click toggles the check; redraw it to match the window that is in front.
                refresh_menu(app);
            }
        }
    }
}

// `spill app` in another folder sends "open<TAB>dir<TAB>port" here.
fn listen(app: AppHandle) {
    let path = socket_path();
    let _ = fs::create_dir_all(spill_home());
    let _ = fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        // Without the socket, `spill app` elsewhere starts its own app instead of adding a window.
        Err(e) => return eprintln!("spill: cannot listen on {}: {e}", path.display()),
    };
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut line = String::new();
            if BufReader::new(&stream).read_line(&mut line).is_err() {
                continue;
            }
            let parts: Vec<String> = line.trim_end_matches(['\r', '\n']).split('\t').map(String::from).collect();
            let arg = |i: usize| parts.get(i).cloned().unwrap_or_default();
            match parts.first().map(String::as_str) {
                Some("open") => {
                    let dir = PathBuf::from(if arg(1).is_empty() { ".".into() } else { arg(1) });
                    let port = arg(2).parse::<u16>().ok();
                    let _ = (&stream).write_all(b"ok\n");
                    let app = app.clone();
                    thread::spawn(move || open_project(&app, &dir, port));
                }
                // S-45: a board page asks for its spec's design window: designs<TAB>root<TAB>spec<TAB>view<TAB>id<TAB>snap.
                Some("designs") => {
                    let root = PathBuf::from(arg(1));
                    let known = fs::canonicalize(&root).ok().is_some_and(|r| app.state::<AppState>().0.lock().unwrap().open.iter().any(|p| p.root == r));
                    let _ = (&stream).write_all(if known { b"ok\n" } else { b"no\n" });
                    if known {
                        let app = app.clone();
                        let (spec, view, id, snap) = (arg(2), arg(3), arg(4), arg(5));
                        thread::spawn(move || open_designs(&app, &root, &spec, &view, &id, &snap));
                    }
                }
                Some("close-designs") => {
                    let root = fs::canonicalize(arg(1)).unwrap_or_default();
                    let label = app.state::<AppState>().0.lock().unwrap().open.iter().find(|p| p.root == root).map(|p| format!("{}-{}", p.label, arg(2)));
                    let _ = (&stream).write_all(if label.is_some() { b"ok\n" } else { b"no\n" });
                    if let Some(win) = label.and_then(|l| app.get_webview_window(&l)) {
                        let _ = win.close();
                    }
                }
                _ => {}
            }
        }
    });
}

fn main() {
    // A second launch hands its folder to the running app and quits.
    let dir = std::env::var("SPILL_OPEN").map(PathBuf::from).unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| ".".into()));
    let port = std::env::var("SPILL_PORT").ok().and_then(|p| p.parse::<u16>().ok());
    if let Ok(mut s) = UnixStream::connect(socket_path()) {
        if s.write_all(format!("open\t{}\t{}\n", dir.display(), port.map(|p| p.to_string()).unwrap_or_default()).as_bytes()).is_ok() {
            return;
        }
    }

    tauri::Builder::default()
        .manage(AppState::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
            listen(handle.clone());
            thread::spawn(move || open_project(&handle, &dir, port));
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match event {
                WindowEvent::Focused(true) => {
                    app.state::<AppState>().0.lock().unwrap().focused = Some(window.label().to_string());
                    refresh_menu(app);
                }
                WindowEvent::Destroyed => {
                    close_project(app, window.label());
                    refresh_menu(app);
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Spill")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state = app.state::<AppState>();
                let mut w = state.0.lock().unwrap();
                for p in w.open.iter_mut() {
                    let _ = p.server.kill();
                    let _ = p.server.wait();
                }
                let _ = fs::remove_file(socket_path());
            }
        });
}
