// The Spill window. The board itself is served by `spill app` (bun), whose URL arrives in SPILL_URL.
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let url = std::env::var("SPILL_URL").unwrap_or_else(|_| "http://localhost:4747".into());
    tauri::Builder::default()
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Spill")
                .inner_size(1440.0, 960.0)
                .min_inner_size(900.0, 600.0);
            // The page's header doubles as the title bar; the traffic lights float over its left edge.
            #[cfg(target_os = "macos")]
            let window = window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(18.0, 20.0));
            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Spill");
}
