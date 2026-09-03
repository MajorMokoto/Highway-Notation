# 3D Highway — Free-Camera Bridge

> 🇬🇧 English · 🇪🇸 Español más abajo

## What this modification does (EN)

This change adds a small, **opt-in** hook inside `camUpdate()` in
[`screen.js`](./screen.js) that lets an external plugin drive the 3D Highway
camera (orbit, height, zoom, tilt, pan) **without forking the renderer**.

The renderer reads a single shared object once per frame:

```js
window.__h3dCamCtl = {
  enabled,     // master switch — when false the renderer auto-frames as usual
  heightMul,   // camera height multiplier
  distMul,     // dolly / zoom multiplier
  yaw,         // orbit around the look target (radians)
  pitch,       // tilt offset (highway K-units)
  panX, panY   // look-target pan (highway K-units)
};
```

**Safety / backward compatibility**
- The bridge object is read **once** (`_freeCam`) and reused for both the
  position and the look-at transforms.
- Every field is coerced with `Number.isFinite` to a safe default
  (`heightMul`/`distMul → 1`, everything else → `0`) before use, so a malformed
  bridge object can **never** feed `NaN` into `cam.position.set` / `cam.lookAt`.
- When `window.__h3dCamCtl` is absent or `enabled === false`, behaviour is
  **byte-for-byte identical** to before: the `if` is skipped and `lookAt` uses
  the existing `else` path.

The shared `-FOCUS_D * 0.35` look-at Z is computed once (`_lookAtZ`) and reused.

## The plugin that uses this bridge

**Camera Director** — a floating, bilingual (EN/ES) control panel to author,
save and share highway camera views:

➡️ **https://github.com/nimuart/cameradirector_feedback**

Camera Director creates and writes `window.__h3dCamCtl`; this renderer only
reads it. That one-object contract is the entire integration surface — no other
globals, no patching of the renderer's internals.

---

## Qué hace esta modificación (ES)

Este cambio agrega un hook pequeño y **opcional** dentro de `camUpdate()` en
[`screen.js`](./screen.js) que permite que un plugin externo maneje la cámara del
3D Highway (órbita, altura, zoom, inclinación, paneo) **sin tener que forkear el
renderer**.

El renderer lee un único objeto compartido una vez por frame:

```js
window.__h3dCamCtl = {
  enabled,     // interruptor maestro — si es false, el renderer encuadra solo
  heightMul,   // multiplicador de altura
  distMul,     // multiplicador de dolly / zoom
  yaw,         // órbita alrededor del objetivo (radianes)
  pitch,       // inclinación (unidades K del highway)
  panX, panY   // paneo del objetivo (unidades K del highway)
};
```

**Seguridad / compatibilidad**
- El objeto se lee **una sola vez** (`_freeCam`) y se reutiliza para la posición
  y para el look-at.
- Cada campo se valida con `Number.isFinite` y cae a un default seguro
  (`heightMul`/`distMul → 1`, el resto → `0`), así un objeto mal formado **nunca**
  mete `NaN` en `cam.position.set` / `cam.lookAt`.
- Si `window.__h3dCamCtl` no existe o `enabled === false`, el comportamiento es
  **idéntico** al de antes.

## El plugin que usa este puente

**Camera Director** — panel flotante y bilingüe (EN/ES) para crear, guardar y
compartir vistas de cámara del highway:

➡️ **https://github.com/nimuart/cameradirector_feedback**

Camera Director crea y escribe `window.__h3dCamCtl`; este renderer solo lo lee.
Ese contrato de un solo objeto es toda la superficie de integración.
