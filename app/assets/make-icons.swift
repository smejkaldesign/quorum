// Renders the Quorum app icon (blue gradient, white circle, llama cut out) and the Quorum avatar mark.
// usage: swiftc make-icons.swift -o make-icons && ./make-icons llama-glyph.svg <out-dir> [dev]
// with `dev`, writes only icon-dev.png and quorum-mark-dev.png: the same art on green, so the dev copy never looks like the real app
import AppKit

let args = CommandLine.arguments
let glyph = NSImage(data: try! Data(contentsOf: URL(fileURLWithPath: args[1])))!
let outDir = URL(fileURLWithPath: args[2])
let dev = args.count > 3 && args[3] == "dev"
let top = dev ? NSColor(srgbRed: 0.3, green: 0.82, blue: 0.45, alpha: 1) : NSColor(srgbRed: 0.32, green: 0.56, blue: 1, alpha: 1)
let bottom = dev ? NSColor(srgbRed: 0.07, green: 0.52, blue: 0.24, alpha: 1) : NSColor(srgbRed: 0.05, green: 0.28, blue: 0.72, alpha: 1)

func bitmap(_ px: Int, _ draw: (CGFloat) -> Void) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw(CGFloat(px))
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

// a disc with the llama punched out; the llama's chest runs off the bottom edge, like the Octocat
func cutoutDisc(_ rect: NSRect, fill: @escaping (NSBezierPath) -> Void) {
    let layer = NSImage(size: rect.size, flipped: false) { r in
        fill(NSBezierPath(ovalIn: r))
        let g = r.width * 0.86
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        glyph.draw(in: NSRect(x: (r.width - g) / 2 - r.width * 0.02, y: -r.width * 0.06, width: g, height: g), from: .zero, operation: .destinationOut, fraction: 1)
        return true
    }
    layer.draw(in: rect)
}

func appIcon(_ px: Int) -> NSBitmapImageRep {
    bitmap(px) { s in
        let body = NSRect(x: 0, y: 0, width: s, height: s).insetBy(dx: s * 0.1, dy: s * 0.1)
        let shape = NSBezierPath(roundedRect: body, xRadius: body.width * 0.225, yRadius: body.width * 0.225)
        NSGradient(starting: top, ending: bottom)!.draw(in: shape, angle: -90)
        let d = body.width * 0.66
        cutoutDisc(NSRect(x: body.midX - d / 2, y: body.midY - d / 2, width: d, height: d)) { path in
            NSColor.white.setFill()
            path.fill()
        }
    }
}

func mark(_ px: Int) -> NSBitmapImageRep {
    bitmap(px) { s in
        cutoutDisc(NSRect(x: 0, y: 0, width: s, height: s)) { path in
            NSGradient(starting: top, ending: bottom)!.draw(in: path, angle: -90)
        }
    }
}

func write(_ rep: NSBitmapImageRep, _ name: String) {
    try! rep.representation(using: .png, properties: [:])!.write(to: outDir.appendingPathComponent(name))
}

if dev { write(appIcon(1024), "icon-dev.png"); write(mark(96), "quorum-mark-dev.png"); exit(0) }

let iconset = outDir.appendingPathComponent("icon.iconset")
try? FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for s in [16, 32, 128, 256, 512] {
    write(appIcon(s), "icon.iconset/icon_\(s)x\(s).png")
    write(appIcon(s * 2), "icon.iconset/icon_\(s)x\(s)@2x.png")
}
write(appIcon(1024), "icon.png")
write(appIcon(64), "icon-64.png")
write(mark(96), "quorum-mark.png")
