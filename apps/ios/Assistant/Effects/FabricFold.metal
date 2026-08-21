#include <metal_stdlib>

using namespace metal;

namespace {
float foldProgress(float phase) {
    return smoothstep(0.0, 1.0, clamp(abs(phase), 0.0, 1.0));
}

float edgeDistance(float normalizedY, float phase) {
    return phase < 0.0 ? normalizedY : 1.0 - normalizedY;
}
}

// Curves the contents into a soft, asymmetric roll as a bubble passes the
// transcript edge. Unlike a rotation, each horizontal strip takes a slightly
// different path, which keeps the surface feeling flexible rather than rigid.
[[ stitchable ]] float2 fabricFold(
    float2 position,
    float phase,
    float4 bounds
) {
    float progress = foldProgress(phase);
    if (progress < 0.001) {
        return position;
    }

    float2 size = max(bounds.zw, float2(1.0));
    float2 normalized = (position - bounds.xy) / size;
    float edge = saturate(edgeDistance(normalized.y, phase));
    float hinge = smoothstep(0.02, 1.0, edge);
    float column = sin(normalized.x * M_PI_F);
    float weave = sin((normalized.x * 1.65 + edge * 1.18) * M_PI_F);
    float fold = progress * hinge * hinge;
    float direction = phase < 0.0 ? 1.0 : -1.0;

    // A soft center holds a little more depth than the edges; the low-amplitude
    // weave prevents the fold from reading as a perfectly rigid sheet.
    float rollDepth = 7.0 + (7.0 * column);
    float verticalDisplacement = direction * (
        (fold * rollDepth) + (progress * hinge * weave * 1.8)
    );
    float lateralDisplacement = direction * progress * hinge * (
        ((normalized.x - 0.5) * 3.2) + (weave * 1.4)
    );

    return position + float2(lateralDisplacement, verticalDisplacement);
}

// Adds the soft falloff and faint highlight that appear when flexible material
// rolls away from a light source. It is intentionally subtle so copy remains
// readable while the edge gains depth.
[[ stitchable ]] half4 fabricFoldShade(
    float2 position,
    half4 color,
    float phase,
    float4 bounds
) {
    float progress = foldProgress(phase);
    if (progress < 0.001) {
        return color;
    }

    float2 size = max(bounds.zw, float2(1.0));
    float2 normalized = (position - bounds.xy) / size;
    float edge = saturate(edgeDistance(normalized.y, phase));
    float hinge = smoothstep(0.06, 1.0, edge);
    float column = sin(normalized.x * M_PI_F);
    float grain = 0.5 + (0.5 * sin((normalized.x * 2.1 + edge) * M_PI_F));
    float fold = progress * hinge * hinge;
    float shade = fold * (0.18 + (0.13 * grain)) * (0.76 + (0.24 * column));
    float highlight = progress * smoothstep(0.08, 0.42, edge)
        * (1.0 - smoothstep(0.42, 0.82, edge)) * 0.055;

    half3 ink = color.rgb * half3(1.0 - shade);
    ink += half3(highlight, highlight * 1.08, highlight * 1.02);
    color.rgb = min(ink, half3(1.0));
    color.a *= half(1.0 - (fold * 0.08));
    return color;
}
