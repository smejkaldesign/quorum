// Renders the Quorum app icon (blue gradient tile, white outlined owl mark) and the avatar mark (the same mark filled
// with the gradient, for dark backgrounds).
// usage: swiftc make-icons.swift -o make-icons && ./make-icons quorum-outlined.svg <out-dir> [dev]
// with `dev`, writes only icon-dev.png and quorum-mark-dev.png: the same art on dev green (#3FE35D), so the dev copy never looks like the real app
import AppKit

let args = CommandLine.arguments
let mark = NSImage(data: try! Data(contentsOf: URL(fileURLWithPath: args[1])))!
let outDir = URL(fileURLWithPath: args[2])
let dev = args.count > 3 && args[3] == "dev"
// brand #007AFF: lighter above, deeper below
let top = dev ? NSColor(srgbRed: 0.42, green: 0.93, blue: 0.52, alpha: 1) : NSColor(srgbRed: 0.2, green: 0.6, blue: 1, alpha: 1)
let bottom = dev ? NSColor(srgbRed: 0.16, green: 0.74, blue: 0.29, alpha: 1) : NSColor(srgbRed: 0, green: 0.4, blue: 0.85, alpha: 1)

func bitmap(_ px: Int, _ draw: (CGFloat) -> Void) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw(CGFloat(px))
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

// the mark drawn with a gradient instead of white: paint the gradient, then keep only the mark's pixels
func gradientMark(_ rect: NSRect) {
    let layer = NSImage(size: rect.size, flipped: false) { r in
        NSGradient(starting: top, ending: bottom)!.draw(in: r, angle: -90)
        mark.draw(in: r, from: .zero, operation: .destinationIn, fraction: 1)
        return true
    }
    layer.draw(in: rect)
}

func appIcon(_ px: Int) -> NSBitmapImageRep {
    bitmap(px) { s in
        let body = NSRect(x: 0, y: 0, width: s, height: s).insetBy(dx: s * 0.1, dy: s * 0.1)
        let shape = NSBezierPath(roundedRect: body, xRadius: body.width * 0.225, yRadius: body.width * 0.225)
        NSGradient(starting: top, ending: bottom)!.draw(in: shape, angle: -90)
        let d = body.width * 0.68
        mark.draw(in: NSRect(x: body.midX - d / 2, y: body.midY - d / 2, width: d, height: d), from: .zero, operation: .sourceOver, fraction: 1)
    }
}

func avatar(_ px: Int) -> NSBitmapImageRep {
    bitmap(px) { s in gradientMark(NSRect(x: 0, y: 0, width: s, height: s)) }
}

func write(_ rep: NSBitmapImageRep, _ name: String) {
    try! rep.representation(using: .png, properties: [:])!.write(to: outDir.appendingPathComponent(name))
}

if dev { write(appIcon(1024), "icon-dev.png"); write(avatar(96), "quorum-mark-dev.png"); exit(0) }

let iconset = outDir.appendingPathComponent("icon.iconset")
try? FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for s in [16, 32, 128, 256, 512] {
    write(appIcon(s), "icon.iconset/icon_\(s)x\(s).png")
    write(appIcon(s * 2), "icon.iconset/icon_\(s)x\(s)@2x.png")
}
write(appIcon(1024), "icon.png")
write(appIcon(64), "icon-64.png")
write(avatar(96), "quorum-mark.png")
