// Renders the DMG window background: one chalk-like blue arc over the app and Applications, ending in an arrow.
// usage: swiftc make-dmg-bg.swift -o make-dmg-bg && ./make-dmg-bg <out-dir>
import AppKit

let W: CGFloat = 540, H: CGFloat = 380
let ink = NSColor(srgbRed: 0.2, green: 0.56, blue: 1, alpha: 1)

// small seeded generator so the chalk grain is the same on every render
struct Rng { var s: UInt64; mutating func next() -> CGFloat { s = s &* 6364136223846793005 &+ 1442695040888963407; return CGFloat((s >> 33) % 10000) / 10000 } }

// icons sit at (150,190) and (390,190) in Finder's top-left coordinates, 96pt wide; the arc rises from above the app
// icon, peaks between them and comes down toward Applications (AppKit y is up)
let curve: [NSPoint] = [NSPoint(x: 166, y: 262), NSPoint(x: 200, y: 346), NSPoint(x: 352, y: 336), NSPoint(x: 378, y: 262)]

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
    for i in 0...96 { pts.append(bez(curve, CGFloat(i) / 96)) }

    // chalk: many faint thin passes, each wandering a little differently, so the edge stays soft and uneven;
    // then a dusting of specks along the line
    var rng = Rng(s: 7)
    func chalk(_ points: [NSPoint], passes: Int, width: CGFloat, amp: CGFloat, alpha: CGFloat) {
        for k in 0..<passes {
            let seed = CGFloat(k) * 1.37 + rng.next() * 3
            ink.withAlphaComponent(alpha).setFill()
            ribbon(points, seed: seed, amp: amp + rng.next() * 0.8, width: width).fill()
        }
        for pt in points {
            for _ in 0..<2 where rng.next() < 0.45 {
                let r = 0.35 + rng.next() * 0.6
                let d = NSPoint(x: pt.x + (rng.next() - 0.5) * width * 2.2, y: pt.y + (rng.next() - 0.5) * width * 2.2)
                ink.withAlphaComponent(0.08 + rng.next() * 0.22).setFill()
                NSBezierPath(ovalIn: NSRect(x: d.x - r, y: d.y - r, width: 2 * r, height: 2 * r)).fill()
            }
        }
    }
    chalk(pts, passes: 7, width: 3.6, amp: 1.4, alpha: 0.16)

    // a short open arrow head, two light strokes meeting at the tip
    let end = curve[3]
    let a = tangent(curve, 1)
    let arm: CGFloat = 15, spread: CGFloat = 0.55
    for side in [a - spread, a + spread] {
        let from = NSPoint(x: end.x - arm * cos(side), y: end.y - arm * sin(side))
        let to = NSPoint(x: end.x + 1.5 * cos(side), y: end.y + 1.5 * sin(side))
        chalk(straight(from, to, steps: 20), passes: 6, width: 3.2, amp: 0.7, alpha: 0.16)
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
for (scale, name) in [(1.0, "dmg-background.png"), (2.0, "dmg-background@2x.png")] as [(CGFloat, String)] {
    try! render(scale: scale).representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name))
}
