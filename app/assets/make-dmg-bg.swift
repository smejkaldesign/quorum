// Renders the DMG window background: a looping arrow from the app to Applications, with two small
// Quorums walking along it in different strides.
// usage: swiftc make-dmg-bg.swift -o make-dmg-bg && ./make-dmg-bg quorum-filled.svg <out-dir>
import AppKit

let W: CGFloat = 540, H: CGFloat = 380
let owlFill = NSColor(srgbRed: 0, green: 0.48, blue: 1, alpha: 1)
let owl = NSImage(data: try! Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))!

// the arrow: four cubic segments with one loop in the middle, sitting above the two icons (AppKit y is up)
let segs: [[NSPoint]] = [
    [NSPoint(x: 178, y: 262), NSPoint(x: 196, y: 292), NSPoint(x: 236, y: 304), NSPoint(x: 262, y: 290)],
    [NSPoint(x: 262, y: 290), NSPoint(x: 290, y: 274), NSPoint(x: 272, y: 246), NSPoint(x: 256, y: 260)],
    [NSPoint(x: 256, y: 260), NSPoint(x: 240, y: 274), NSPoint(x: 262, y: 306), NSPoint(x: 306, y: 302)],
    [NSPoint(x: 306, y: 302), NSPoint(x: 340, y: 299), NSPoint(x: 358, y: 282), NSPoint(x: 366, y: 262)],
]

func bez(_ s: [NSPoint], _ t: CGFloat) -> NSPoint {
    let u = 1 - t
    return NSPoint(x: u*u*u*s[0].x + 3*u*u*t*s[1].x + 3*u*t*t*s[2].x + t*t*t*s[3].x,
                   y: u*u*u*s[0].y + 3*u*u*t*s[1].y + 3*u*t*t*s[2].y + t*t*t*s[3].y)
}
func tangent(_ s: [NSPoint], _ t: CGFloat) -> CGFloat {
    let a = bez(s, max(0, t - 0.01)), b = bez(s, min(1, t + 0.01))
    return atan2(b.y - a.y, b.x - a.x)
}

// the filled owl, tinted: paint the color, keep only the glyph's pixels
func drawOwl(at p: NSPoint, height: CGFloat, angle: CGFloat) {
    let w = height * owl.size.width / owl.size.height
    let layer = NSImage(size: NSSize(width: w, height: height), flipped: false) { r in
        owlFill.setFill(); r.fill()
        owl.draw(in: r, from: .zero, operation: .destinationIn, fraction: 1)
        return true
    }
    NSGraphicsContext.saveGraphicsState()
    var m = AffineTransform(translationByX: p.x, byY: p.y)
    m.rotate(byRadians: angle)
    (m as NSAffineTransform).concat()
    layer.draw(in: NSRect(x: -w / 2, y: 0, width: w, height: height))
    NSGraphicsContext.restoreGraphicsState()
}

func render(scale: CGFloat) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * scale), pixelsHigh: Int(H * scale), bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: W, height: H)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // soft blue wash so the window feels like Quorum, light enough for Finder's black icon labels
    NSGradient(starting: NSColor(srgbRed: 0.96, green: 0.98, blue: 1, alpha: 1), ending: NSColor(srgbRed: 0.9, green: 0.95, blue: 1, alpha: 1))!
        .draw(in: NSRect(x: 0, y: 0, width: W, height: H), angle: -90)

    // hand-drawn look: walk the curve, nudge each point off the line by a smooth, seeded wobble, and stroke it
    // twice with slightly different wobbles like a pencil going over a line
    var pts: [NSPoint] = []
    for sgm in segs { for i in 0..<40 { pts.append(bez(sgm, CGFloat(i) / 40)) } }
    pts.append(segs[3][3])
    func sketch(_ points: [NSPoint], seed: CGFloat, amp: CGFloat) -> NSBezierPath {
        let p = NSBezierPath()
        for (i, pt) in points.enumerated() {
            let a = i == 0 ? points[1] : points[i - 1], b = i == points.count - 1 ? points[i - 1] : points[i + 1]
            let dx = b.x - a.x, dy = b.y - a.y, len = max(0.001, hypot(dx, dy))
            let wob = amp * (sin(CGFloat(i) * 0.37 + seed) * 0.6 + sin(CGFloat(i) * 0.13 + seed * 2.1) * 0.4)
            let q = NSPoint(x: pt.x - dy / len * wob, y: pt.y + dx / len * wob)
            if i == 0 { p.move(to: q) } else { p.line(to: q) }
        }
        p.lineCapStyle = .round
        p.lineJoinStyle = .round
        return p
    }
    let grey = NSColor(srgbRed: 0.55, green: 0.55, blue: 0.6, alpha: 1)
    for (seed, width, alpha) in [(0.0, 2.4, 0.75), (1.7, 1.3, 0.45)] as [(CGFloat, CGFloat, CGFloat)] {
        let line = sketch(pts, seed: seed, amp: 0.9)
        line.lineWidth = width
        grey.withAlphaComponent(alpha).setStroke()
        line.stroke()
    }

    // a hand-drawn > at the end, pointing along the curve
    let end = segs[3][3]
    let a = tangent(segs[3], 1)
    let arm: CGFloat = 15, spread: CGFloat = 0.62
    let tip = NSPoint(x: end.x + 2 * cos(a), y: end.y + 2 * sin(a))
    let wing1 = NSPoint(x: tip.x - arm * cos(a - spread), y: tip.y - arm * sin(a - spread))
    let wing2 = NSPoint(x: tip.x - arm * cos(a + spread), y: tip.y - arm * sin(a + spread))
    func strokeLine(_ from: NSPoint, _ to: NSPoint) -> [NSPoint] { (0...8).map { i in let t = CGFloat(i) / 8; return NSPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t) } }
    for (seed, width, alpha) in [(0.4, 2.6, 0.8), (2.2, 1.3, 0.45)] as [(CGFloat, CGFloat, CGFloat)] {
        grey.withAlphaComponent(alpha).setStroke()
        for side in [wing1, wing2] {
            let l = sketch(strokeLine(side, tip), seed: seed, amp: 0.5)
            l.lineWidth = width
            l.stroke()
        }
    }

    // two owls perched on the curve, tilted a little with the slope
    for (seg, t, size) in [(0, 0.38, 34.0), (3, 0.22, 30.0)] as [(Int, CGFloat, CGFloat)] {
        let at = bez(segs[seg], t)
        drawOwl(at: NSPoint(x: at.x, y: at.y + 3), height: size, angle: tangent(segs[seg], t) * 0.35)
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let out = URL(fileURLWithPath: CommandLine.arguments[2])
for (scale, name) in [(1.0, "dmg-background.png"), (2.0, "dmg-background@2x.png")] as [(CGFloat, String)] {
    try! render(scale: scale).representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name))
}
