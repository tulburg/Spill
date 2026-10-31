// The Spill window. The board itself is served by `spill app` (bun), whose URL arrives in SPILL_URL.
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let url = std::env::var("SPILL_URL").unwrap_or_else(|_| "http://localhost:4747".into());
    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Spill")
                .inner_size(1440.0, 960.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Spill");
}
