// S-44: render a design page to PNG with headless WebKit, for spill_design_screenshot.
// Usage: spill-render <page.html> <out.png> <width> <height> <scale> <node-id>
// The page is laid out at width x height; the PNG is cropped to the element with data-node="<node-id>".
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count == 7, Double(args[3]) != nil, Double(args[4]) != nil, Double(args[5]) != nil else {
  FileHandle.standardError.write("usage: spill-render page.html out.png width height scale node\n".data(using: .utf8)!)
  exit(2)
}
let width = Double(args[3])!
let height = Double(args[4])!
let scale = Double(args[5])!
let page = URL(fileURLWithPath: args[1])
let out = URL(fileURLWithPath: args[2])
let node = args[6]

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

class Renderer: NSObject, WKNavigationDelegate {
  let view: WKWebView
  let window: NSWindow

  override init() {
    let config = WKWebViewConfiguration()
    config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
    let frame = NSRect(x: 0, y: 0, width: width, height: height)
    view = WKWebView(frame: frame, configuration: config)
    // An offscreen window gives the view a backing scale, so 2x renders are sharp.
    window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = view
    super.init()
    view.navigationDelegate = self
    view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let js = """
      (() => { const e = document.querySelector('[data-node="\(node)"]'); if (!e) return null;
        const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()
      """
    // Let fonts and images settle before measuring.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
      webView.evaluateJavaScript(js) { result, _ in
        guard let r = result as? [Double], r[2] > 0, r[3] > 0 else { fail("No node \(node) to render") }
        let snap = WKSnapshotConfiguration()
        snap.rect = NSRect(x: r[0], y: r[1], width: min(r[2], width - r[0]), height: min(r[3], height - r[1]))
        // snapshotWidth is in points; the screen's backing scale multiplies it again.
        snap.snapshotWidth = NSNumber(value: snap.rect.width * scale / self.window.backingScaleFactor)
        webView.takeSnapshot(with: snap) { image, err in
          guard let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                let png = rep.representation(using: .png, properties: [:]) else { fail("Snapshot failed: \(String(describing: err))") }
          do { try png.write(to: out) } catch { fail("Cannot write \(out.path)") }
          exit(0)
        }
      }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("Load failed: \(error)") }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("Load failed: \(error)") }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let renderer = Renderer()
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { fail("Render timed out") }
app.run()
