// Renders the DMG window background: one hand-drawn blue line from the app to Applications, ending in an arrow.
// usage: swiftc make-dmg-bg.swift -o make-dmg-bg && ./make-dmg-bg <out-dir>
import AppKit

let W: CGFloat = 540, H: CGFloat = 380
let ink = NSColor(srgbRed: 0, green: 0.48, blue: 1, alpha: 1)

// icons sit at (150,190) and (390,190) in Finder's top-left coordinates, 96pt wide; the line runs between them,
// bowing upward a little (AppKit y is up)
let curve: [NSPoint] = [NSPoint(x: 206, y: 198), NSPoint(x: 244, y: 226), NSPoint(x: 298, y: 226), NSPoint(x: 334, y: 200)]

func bez(_ s: [NSPoint], _ t: CGFloat) -> NSPoint {
    let u = 1 - t
    return NSPoint(x: u*u*u*s[0].x + 3*u*u*t*s[1].x + 3*u*t*t*s[2].x + t*t*t*s[3].x,
                   y: u*u*u*s[0].y + 3*u*u*t*s[1].y + 3*u*t*t*s[2].y + t*t*t*s[3].y)
}
func tangent(_ s: [NSPoint], _ t: CGFloat) -> CGFloat {
    let a = bez(s, max(0, t - 0.01)), b = bez(s, min(1, t + 0.01))
    return atan2(b.y - a.y, b.x - a.x)
}

// seeded smooth noise: three sines at unrelated frequencies, so the line wanders without repeating visibly
func wobble(_ i: CGFloat, seed: CGFloat) -> CGFloat {
    sin(i * 0.31 + seed) * 0.5 + sin(i * 0.11 + seed * 2.3) * 0.35 + sin(i * 0.53 + seed * 0.7) * 0.15
}

// a stroke drawn as a filled ribbon whose width swells in the middle and thins at both ends, like a marker that
// lands lightly, presses, and lifts. Each sample is pushed off the path by the wobble
func ribbon(_ points: [NSPoint], seed: CGFloat, amp: CGFloat, width: CGFloat) -> NSBezierPath {
    var left: [NSPoint] = [], right: [NSPoint] = []
    let n = points.count
    for (i, pt) in points.enumerated() {
        let a = i == 0 ? points[1] : points[i - 1], b = i == n - 1 ? points[i - 1] : points[i + 1]
        let dx = b.x - a.x, dy = b.y - a.y, len = max(0.001, hypot(dx, dy))
        let nx = -dy / len, ny = dx / len
        let off = amp * wobble(CGFloat(i), seed: seed)
        let t = CGFloat(i) / CGFloat(n - 1)
        let press = 0.35 + 0.65 * sin(t * .pi)
        let w = width * press * (1 + 0.25 * wobble(CGFloat(i) * 1.7, seed: seed + 9)) / 2
        let c = NSPoint(x: pt.x + nx * off, y: pt.y + ny * off)
        left.append(NSPoint(x: c.x + nx * w, y: c.y + ny * w))
        right.append(NSPoint(x: c.x - nx * w, y: c.y - ny * w))
    }
    let p = NSBezierPath()
    p.move(to: left[0])
    for q in left.dropFirst() { p.line(to: q) }
    for q in right.reversed() { p.line(to: q) }
    p.close()
    p.lineJoinStyle = .round
    return p
}

func straight(_ from: NSPoint, _ to: NSPoint, steps: Int = 14) -> [NSPoint] {
    (0...steps).map { i in let t = CGFloat(i) / CGFloat(steps); return NSPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t) }
}

func render(scale: CGFloat) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * scale), pixelsHigh: Int(H * scale), bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: W, height: H)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // soft blue wash, light enough for Finder's black icon labels
    NSGradient(starting: NSColor(srgbRed: 0.96, green: 0.98, blue: 1, alpha: 1), ending: NSColor(srgbRed: 0.9, green: 0.95, blue: 1, alpha: 1))!
        .draw(in: NSRect(x: 0, y: 0, width: W, height: H), angle: -90)

    var pts: [NSPoint] = []
    for i in 0...72 { pts.append(bez(curve, CGFloat(i) / 72)) }

    // the line: a solid pass, then a thinner lighter pass with its own wobble, the way a second stroke never
    // quite follows the first
    ink.withAlphaComponent(0.9).setFill(); ribbon(pts, seed: 0.0, amp: 2.2, width: 3.8).fill()
    ink.withAlphaComponent(0.35).setFill(); ribbon(pts, seed: 2.9, amp: 3.0, width: 1.6).fill()

    // the arrow head: two strokes that run past the tip and cross, as a quick hand draws it
    let end = curve[3]
    let a = tangent(curve, 1)
    let arm: CGFloat = 19, spread: CGFloat = 0.58, over: CGFloat = 4
    let tip = NSPoint(x: end.x + 1.5 * cos(a), y: end.y + 1.5 * sin(a))
    for (side, seed) in [(a - spread, 4.1), (a + spread, 6.3)] as [(CGFloat, CGFloat)] {
        let from = NSPoint(x: tip.x - arm * cos(side), y: tip.y - arm * sin(side))
        let to = NSPoint(x: tip.x + over * cos(side), y: tip.y + over * sin(side))
        ink.withAlphaComponent(0.9).setFill(); ribbon(straight(from, to), seed: seed, amp: 0.8, width: 3.2).fill()
        ink.withAlphaComponent(0.35).setFill(); ribbon(straight(from, to), seed: seed + 1.3, amp: 1.2, width: 1.4).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
for (scale, name) in [(1.0, "dmg-background.png"), (2.0, "dmg-background@2x.png")] as [(CGFloat, String)] {
    try! render(scale: scale).representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name))
}
