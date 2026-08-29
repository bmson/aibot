import SwiftUI
import WebKit

struct MermaidDiagramView: View {
    let source: String

    @Environment(\.colorScheme) private var colorScheme
    @State private var renderedHeight: CGFloat = 180

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("DIAGRAM")
                .font(.caption2.weight(.bold))
                .tracking(0.8)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
            Divider()
            MermaidWebView(
                source: String(source.prefix(20_000)),
                darkMode: colorScheme == .dark,
                renderedHeight: $renderedHeight
            )
            .frame(height: min(max(renderedHeight, 100), 560))
            DisclosureGroup("View diagram source") {
                Text(source)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8)
            }
            .font(.caption.weight(.medium))
            .padding(12)
        }
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(.primary.opacity(0.09), lineWidth: 0.75)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Mermaid diagram")
    }
}

private struct MermaidWebView: UIViewRepresentable {
    let source: String
    let darkMode: Bool
    @Binding var renderedHeight: CGFloat

    func makeCoordinator() -> Coordinator {
        Coordinator(height: $renderedHeight)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(context.coordinator, name: "height")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.navigationDelegate = context.coordinator
        load(view, coordinator: context.coordinator)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        guard context.coordinator.source != source || context.coordinator.darkMode != darkMode else {
            return
        }
        load(view, coordinator: context.coordinator)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "height")
        view.stopLoading()
    }

    private func load(_ view: WKWebView, coordinator: Coordinator) {
        guard let resourceURL = Bundle.main.resourceURL else { return }
        coordinator.source = source
        coordinator.darkMode = darkMode
        let encoded = Data(source.utf8).base64EncodedString()
        let background = darkMode ? "#17201b" : "#f7faf8"
        let ink = darkMode ? "#eef7f1" : "#17251d"
        let html = """
        <!doctype html><html><head>
        <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
        <style>
        html,body{margin:0;padding:0;background:transparent;color:\(ink);overflow:hidden}
        #diagram{padding:14px;background:\(background);box-sizing:border-box;min-height:90px}
        svg{display:block;max-width:100%;height:auto;margin:0 auto}
        .error{font:14px -apple-system;color:\(ink);padding:14px}
        </style>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
        <script src="mermaid.min.js"></script></head><body><div id="diagram"></div>
        <script>
        const bytes=Uint8Array.from(atob('\(encoded)'),c=>c.charCodeAt(0));
        const source=new TextDecoder().decode(bytes);
        mermaid.initialize({startOnLoad:false,securityLevel:'strict',htmlLabels:false,theme:'base',flowchart:{htmlLabels:false,useMaxWidth:true},themeVariables:{primaryColor:'#e8f2ec',primaryTextColor:'\(ink)',primaryBorderColor:'#2d8a5a',lineColor:'#47745c',secondaryColor:'\(background)',tertiaryColor:'\(background)'}});
        (async()=>{try{const out=await mermaid.render('diagram-svg',source);document.getElementById('diagram').innerHTML=out.svg}catch(e){document.getElementById('diagram').innerHTML='<div class="error">This Mermaid diagram could not be rendered.</div>'}requestAnimationFrame(()=>window.webkit.messageHandlers.height.postMessage(document.documentElement.scrollHeight));})();
        </script></body></html>
        """
        view.loadHTMLString(html, baseURL: resourceURL)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        @Binding var height: CGFloat
        var source = ""
        var darkMode = false

        init(height: Binding<CGFloat>) {
            _height = height
        }

        func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "height", let value = message.body as? NSNumber else { return }
            height = CGFloat(truncating: value)
        }

        func webView(
            _: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.navigationType == .other else {
                decisionHandler(.cancel)
                return
            }
            let scheme = navigationAction.request.url?.scheme?.lowercased()
            decisionHandler(scheme == nil || scheme == "about" || scheme == "file" ? .allow : .cancel)
        }
    }
}
