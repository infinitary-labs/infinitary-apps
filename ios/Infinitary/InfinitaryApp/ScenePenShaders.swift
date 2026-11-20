/// INF-3851 piece 2: the scene pen's shaders, compiled when the renderer first starts (`ScenePenGPU`), so building the
/// app needs no Metal toolchain of its own.
enum ScenePenShaders {
    static let source = #"""
#include <metal_stdlib>
using namespace metal;

// The scene pen's graphics-chip batch (`PenBatch`, `ScenePenGPU`). Every shape the painters draw
// arrives as one instance record: a quad that bounds it, the shape's exact geometry in target pixels, and its paint.
// Coverage comes from distance to the shape, measured as a one-pixel box filter, as Core Graphics' coverage is.
// The layout matches `PenInstance` in PenBatch.swift float for float.
struct PenInstance {
    float4 quad;      // origin.xy, u.xy
    float4 quadV;     // v.xy, kind, flags
    float4 geo0;
    float4 geo1;
    float4 geo2;
    float4 paint;     // shading kind, stop count, opacity, unused
    float4 paintGeo;  // radial: center.xy, r0, r1; linear: from.xy, to.xy
    float4 color0;
    float4 color1;
    float4 color2;
    float4 color3;
    float4 stops;
};

struct PenFragmentIn {
    float4 position [[position]];
    float2 st;
    uint instance [[flat]];
};

struct PenViewport { float2 size; };

constant float kindEllipse = 0, kindRing = 1, kindSegment = 2, kindPolygon = 3;

vertex PenFragmentIn penVertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                               const device PenInstance *instances [[buffer(0)]],
                               constant PenViewport &viewport [[buffer(1)]]) {
    PenInstance i = instances[iid];
    float2 st = float2(float(vid & 1), float(vid >> 1));
    float2 at = i.quad.xy + i.quad.zw * st.x + i.quadV.xy * st.y;
    PenFragmentIn out;
    out.position = float4(at.x / viewport.size.x * 2 - 1, 1 - at.y / viewport.size.y * 2, 0, 1);
    out.st = st;
    out.instance = iid;
    return out;
}

/// The share of a pixel, a unit square centred on the origin, lying where `dot(x, n) <= s` for the unit normal `n`:
/// the exact area, as Core Graphics measures it, so a slanted edge ramps over the pixel's whole width across it.
static float edge(float s, float2 n) {
    float a = max(abs(n.x), abs(n.y)), b = min(abs(n.x), abs(n.y)), w = a + b;
    float t = s + 0.5 * w;
    if (t <= 0) { return 0; }
    if (t >= w) { return 1; }
    if (b < 1e-4) { return clamp(t / max(a, 1e-6), 0.0, 1.0); }
    if (t < b) { return t * t / (2 * a * b); }
    if (t <= a) { return (t - 0.5 * b) / a; }
    float u = w - t;
    return 1 - u * u / (2 * a * b);
}

/// The share of a pixel, centred `d` from a band's middle line along `n`, that a band `reach` wide each side covers.
static float band(float d, float reach, float2 n) {
    return clamp(edge(reach - d, n) - edge(-reach - d, n), 0.0, 1.0);
}

/// A unit vector along `v`, or across the pixel when `v` is too short to name a direction.
static float2 unit(float2 v) {
    float l = length(v);
    return l > 1e-6 ? v / l : float2(1, 0);
}

/// How far `Path(ellipseIn:)`'s quarter curves reach in direction `q`, against the true circle's 1. Core Graphics strokes
/// those curves, which run up to 0.027% outside the circle: a quarter pixel on a ring a thousand pixels across.
static float curveReach(float2 q) {
    float u = abs(q.x), v = abs(q.y);
    if (u + v <= 0) { return 1; }
    const float k = 0.5522847498;
    float t = atan2(v, u) / M_PI_2_F;
    for (int n = 0; n < 3; n++) {
        float s = 1 - t;
        float x = s * s * s + 3 * s * s * t + 3 * s * t * t * k, y = t * t * t + 3 * t * t * s + 3 * t * s * s * k;
        float dx = 6 * s * t * (k - 1) - 3 * k * t * t, dy = 6 * s * t * (1 - k) + 3 * k * s * s;
        float f = x * v - y * u, df = dx * v - dy * u;
        if (df != 0) { t = clamp(t - f / df, 0.0, 1.0); }
    }
    float s = 1 - t;
    return length(float2(s * s * s + 3 * s * s * t + 3 * s * t * t * k, t * t * t + 3 * t * t * s + 3 * t * s * s * k));
}

/// Which side of the mitre line at `joint` a point lies on, the same expression for both segments that meet there,
/// so each pixel belongs to exactly one of them and a translucent line never darkens at its joints.
static float side(float2 p, float2 before, float2 joint, float2 after) {
    float2 a = joint - before, b = after - joint;
    float la = length(a), lb = length(b);
    float2 n = (la > 0 ? a / la : float2(0)) + (lb > 0 ? b / lb : float2(0));
    if (dot(n, n) < 1e-10) { n = la > 0 ? a / la : float2(1, 0); }
    return dot(p - joint, n);
}

static float4 penShade(PenInstance i, float2 p) {
    int kind = int(i.paint.x), count = int(i.paint.y);
    if (kind == 0 || count < 2) { return i.color0; }
    float t;
    if (kind == 1) {
        float span = i.paintGeo.w - i.paintGeo.z;
        t = span != 0 ? (length(p - i.paintGeo.xy) - i.paintGeo.z) / span : 1;
    } else {
        float2 axis = i.paintGeo.zw - i.paintGeo.xy;
        float length2 = dot(axis, axis);
        t = length2 > 0 ? dot(p - i.paintGeo.xy, axis) / length2 : 0;
    }
    float4 colors[4] = { i.color0, i.color1, i.color2, i.color3 };
    float stops[4] = { i.stops.x, i.stops.y, i.stops.z, i.stops.w };
    if (t <= stops[0]) { return colors[0]; }
    for (int k = 1; k < count; k++) {
        if (t <= stops[k]) {
            float span = stops[k] - stops[k - 1];
            return mix(colors[k - 1], colors[k], span > 0 ? (t - stops[k - 1]) / span : 1);
        }
    }
    return colors[count - 1];
}

fragment float4 penFragment(PenFragmentIn in [[stage_in]],
                            const device PenInstance *instances [[buffer(0)]],
                            const device float2 *points [[buffer(1)]]) {
    PenInstance i = instances[in.instance];
    float2 p = in.position.xy;
    float kind = i.quadV.z;
    float coverage;
    if (kind == kindEllipse) {
        float2 q = p - i.geo0.xy, r = i.geo0.zw;
        if (abs(r.x - r.y) <= 1e-3 * max(r.x, r.y)) {
            coverage = band(length(q), r.x * curveReach(q), unit(q));
        } else {
            float reach = curveReach(q / r);
            float2 n = q / (r * reach), g = q / (r * r * reach * reach);
            float d = (dot(n, n) - 1) / max(2 * length(g), 1e-6);
            coverage = edge(-d, unit(g));
        }
    } else if (kind == kindRing) {
        float2 q = p - i.geo0.xy;
        coverage = band(length(q) - i.geo0.z * curveReach(q), i.geo0.w, unit(q));
    } else if (kind == kindSegment) {
        float2 a = i.geo0.xy, b = i.geo0.zw;
        uint flags = uint(i.quadV.w);
        bool hasPrev = (flags & 1) != 0, hasNext = (flags & 2) != 0;
        if (hasPrev && side(p, i.geo1.xy, a, b) < 0) { discard_fragment(); }
        if (hasNext && side(p, a, b, i.geo1.zw) >= 0) { discard_fragment(); }
        float2 d = b - a;
        float l = length(d);
        float2 dir = l > 0 ? d / l : float2(1, 0);
        float t = dot(p - a, dir), reach = i.geo2.x;
        float capStart = i.geo2.y, capEnd = i.geo2.z;
        float lo = (hasPrev || capStart == 1) ? 0 : -INFINITY, hi = (hasNext || capEnd == 1) ? l : INFINITY;
        float along = 1;
        // A butt end stops at its point; a square end runs half the width past it.
        if (!hasPrev && capStart != 1) { along *= edge(t + (capStart == 2 ? reach : 0), dir); }
        if (!hasNext && capEnd != 1) { along *= edge(l + (capEnd == 2 ? reach : 0) - t, dir); }
        float2 nearest = a + dir * clamp(t, lo, hi);
        // Across the line's body the edge runs along the line, even for a pixel centred on it; past an end, round the end.
        float2 across = (t >= lo && t <= hi) ? float2(-dir.y, dir.x) : unit(p - nearest);
        coverage = band(length(p - nearest), reach, across) * along;
    } else {
        int first = int(i.geo0.x), count = int(i.geo0.y);
        float orientation = i.geo0.z;
        coverage = 1;
        for (int k = 0; k < count; k++) {
            float2 from = points[first + k], to = points[first + (k + 1) % count];
            float2 e = to - from;
            float le = length(e);
            if (le <= 0) { continue; }
            float inside = orientation * (e.x * (p.y - from.y) - e.y * (p.x - from.x)) / le;
            coverage *= edge(inside, e / le);
            if (coverage <= 0) { break; }
        }
    }
    if (coverage <= 0) { discard_fragment(); }
    float4 color = penShade(i, p);
    float alpha = clamp(color.a, 0.0, 1.0) * coverage * i.paint.z;
    return float4(clamp(color.rgb, 0.0, 1.0) * alpha, alpha);
}

/// A blurred layer laid over its rectangle at its opacity; geo0.xy scales the quad to the part of the texture drawn.
fragment float4 penLayerFragment(PenFragmentIn in [[stage_in]],
                                 const device PenInstance *instances [[buffer(0)]],
                                 texture2d<float> layer [[texture(0)]]) {
    constexpr sampler linear(filter::linear, address::clamp_to_edge);
    PenInstance i = instances[in.instance];
    return layer.sample(linear, in.st * i.geo0.xy) * i.paint.z;
}

struct PenBlurIn { float4 position [[position]]; };

vertex PenBlurIn penBlurVertex(uint vid [[vertex_id]]) {
    float2 at = float2(float((vid << 1) & 2), float(vid & 2));
    PenBlurIn out;
    out.position = float4(at * 2 - 1, 0, 1);
    return out;
}

struct PenBlur { int4 sizeStep; int4 reach; };

/// One box pass along `step`, extending the layer's edge pixels as vImage's edge-extend does.
fragment float4 penBlurFragment(PenBlurIn in [[stage_in]], texture2d<float> source [[texture(0)]],
                                constant PenBlur &blur [[buffer(0)]]) {
    int2 at = int2(in.position.xy);
    float4 sum = 0;
    int2 size = blur.sizeStep.xy, step = blur.sizeStep.zw;
    int reach = blur.reach.x;
    for (int k = -reach; k <= reach; k++) {
        int2 from = clamp(at + step * k, int2(0), size - 1);
        sum += source.read(uint2(from));
    }
    return sum / float(2 * reach + 1);
}
"""#
}
