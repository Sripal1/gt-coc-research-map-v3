precision highp float;

uniform sampler2D texture;

// Passed from the vertex shader
varying vec2 fragTextureCoord;
varying float fragAlpha;

void main() {
  vec2 cxy = 2.0 * gl_PointCoord - 1.0;
  float dist = dot(cxy, cxy);

  if (dist > 1.0) {
    discard;
    return;
  }

  // Smooth anti-aliased edge falloff
  float edgeSoftness = smoothstep(1.0, 0.7, dist);

  // Need to pre-compute alpha
  // https://medium.com/david-guan/alpha-blending-and-webgl-823d86de00d8
  vec4 color = texture2D(texture, fragTextureCoord);
  vec4 colorOpacity = color * fragAlpha * color[3] * edgeSoftness;
  gl_FragColor = colorOpacity;
}