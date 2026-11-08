// Renders the DMG window background: a looping arrow from the app to Applications, with two small
// Quorums walking along it in different strides.
// usage: swiftc make-dmg-bg.swift -o make-dmg-bg && ./make-dmg-bg <out-dir>
import AppKit

let W: CGFloat = 540, H: CGFloat = 380
let llamaFill = NSColor(srgbRed: 0.33, green: 0.05, blue: 0.72, alpha: 1)

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

// a side-on llama, feet at the origin, facing right; stride 0 or 1 swaps which legs are forward
// returns its parts separately: filled one by one, overlaps never cancel out
func llama(stride: Int) -> [NSBezierPath] {
    var parts: [NSBezierPath] = []
    // body, with a little tail tuft at the back
    parts.append(NSBezierPath(roundedRect: NSRect(x: -18, y: 16, width: 32, height: 15), xRadius: 7.5, yRadius: 7.5))
    parts.append(NSBezierPath(ovalIn: NSRect(x: -22, y: 23, width: 8, height: 7)))
    // neck rising from the chest, head with a short snout
    let neck = NSBezierPath()
    neck.move(to: NSPoint(x: 6, y: 24)); neck.line(to: NSPoint(x: 9, y: 46)); neck.line(to: NSPoint(x: 17, y: 46)); neck.line(to: NSPoint(x: 15, y: 24)); neck.close()
    parts.append(neck)
    parts.append(NSBezierPath(roundedRect: NSRect(x: 8, y: 42, width: 13, height: 9), xRadius: 4.5, yRadius: 4.5))
    parts.append(NSBezierPath(roundedRect: NSRect(x: 15, y: 42, width: 10, height: 6), xRadius: 3, yRadius: 3))
    // ears
    for x in [CGFloat(9.5), 13.5] {
        let ear = NSBezierPath()
        ear.move(to: NSPoint(x: x, y: 49)); ear.line(to: NSPoint(x: x + 1, y: 58)); ear.line(to: NSPoint(x: x + 3.4, y: 49)); ear.close()
        parts.append(ear)
    }
    // legs as solid quads from hip to hoof, so they never detach from the body
    let hips: [CGFloat] = [-13, -7, 5, 10]
    let feet: [CGFloat] = stride == 0 ? [4, -3, -4, 4] : [-3, 4, 4, -3]
    for (i, x) in hips.enumerated() {
        let f = x + feet[i]
        let leg = NSBezierPath()
        leg.move(to: NSPoint(x: x - 2, y: 20)); leg.line(to: NSPoint(x: x + 2, y: 20))
        leg.line(to: NSPoint(x: f + 1.8, y: 0)); leg.line(to: NSPoint(x: f - 1.8, y: 0)); leg.close()
        parts.append(leg)
    }
    return parts
}

func render(scale: CGFloat) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * scale), pixelsHigh: Int(H * scale), bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: W, height: H)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // soft lavender wash so the window feels like Quorum, light enough for Finder's black icon labels
    NSGradient(starting: NSColor(srgbRed: 0.97, green: 0.96, blue: 1, alpha: 1), ending: NSColor(srgbRed: 0.93, green: 0.91, blue: 0.98, alpha: 1))!
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

    // two Quorums walking along the curve, feet on the line, tilted with the slope
    for (seg, t, stride, size) in [(0, 0.38, 0, 0.78), (3, 0.22, 1, 0.72)] as [(Int, CGFloat, Int, CGFloat)] {
        let at = bez(segs[seg], t)
        // lean only part way into the slope, the way a walker stays mostly upright
        let ang = tangent(segs[seg], t) * 0.45
        var m = AffineTransform(scale: size)
        m.append(AffineTransform(rotationByRadians: ang))
        m.append(AffineTransform(translationByX: at.x, byY: at.y + 5))
        llamaFill.setFill()
        for part in llama(stride: stride) { part.transform(using: m); part.fill() }
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
for (scale, name) in [(1.0, "dmg-background.png"), (2.0, "dmg-background@2x.png")] as [(CGFloat, String)] {
    try! render(scale: scale).representation(using: .png, properties: [:])!.write(to: out.appendingPathComponent(name))
}
