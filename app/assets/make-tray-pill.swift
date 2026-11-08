// Menu bar pills behind a white llama. macOS lightens non-template menu bar images, so the
// listening green is darker on disk and lands on Zoom's #7fdb83 on screen (measured 2026-11-06).
// usage: swiftc make-tray-pill.swift -o pill && ./pill llama-glyph.svg <out.png> <scale> <listening|focused|dev>
import AppKit

let a = CommandLine.arguments
let scale = CGFloat(Double(a[3])!)
let style = a[4]
let svg = try! String(contentsOfFile: a[1], encoding: .utf8).replacingOccurrences(of: "fill=\"#000\"", with: "fill=\"#ffffff\"")
let glyph = NSImage(data: svg.data(using: .utf8)!)!

// listening: Zoom-size green pill; focused: the translucent highlight macOS draws behind an open menu bar item
// focused and dev are circles; dev is solid black so the development copy stands out
let (pw, ph, fill): (CGFloat, CGFloat, NSColor) = style == "listening"
    ? (40, 24, NSColor(deviceRed: 0.255, green: 0.855, blue: 0.388, alpha: 1))
    : style == "dev" ? (24, 24, NSColor(deviceWhite: 0, alpha: 1)) : (24, 24, NSColor(deviceWhite: 1, alpha: 0.28))
let w = pw * scale, h = ph * scale
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(w), pixelsHigh: Int(h), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
fill.setFill()
let body = NSRect(x: 0, y: 0, width: w, height: h)
let radius = h / 2
NSBezierPath(roundedRect: body, xRadius: radius, yRadius: radius).fill()
let g = (style == "listening" ? 18 : 16) * scale
glyph.draw(in: NSRect(x: (w - g) / 2, y: (h - g) / 2, width: g, height: g))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
