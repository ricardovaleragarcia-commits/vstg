"use client";

import { useEffect, useRef, useState } from "react";
import { Application, Assets, BlurFilter, Container, Filter, GlProgram, Graphics, Sprite, Text, Texture, TilingSprite } from "pixi.js";
import {
  initArchive,
  BLOCK_HEIGHT,
  BLOCK_WIDTH,
  COLUMN_WIDTH,
  piecesForBlock,
  type Piece,
} from "@/lib/demo-collection";

const BLUR = 14;
const GRAIN = 0.07; // strength of the film grain over photographs: opacity of the darkest and lightest specks

// One small noise tile, shared by every photograph. Half of the specks are black and half white
// (each with a random opacity), so the grain adds texture without darkening or lightening the picture.
// One texel is one device pixel, which keeps the grain as fine as the screen allows.
let grainCache: Texture | null = null;
function grainTexture(): Texture {
  if (grainCache) return grainCache;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const data = ctx.createImageData(size, size);
  for (let i = 0; i < data.data.length; i += 4) {
    const light = Math.random() < 0.5;
    const v = light ? 255 : 0;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
    data.data[i + 3] = Math.round(Math.random() * 255);
  }
  ctx.putImageData(data, 0, 0);
  grainCache = Texture.from(canvas);
  grainCache.source.resolution = window.devicePixelRatio || 1;
  return grainCache;
}

// ---- Dissolve: the photograph appears grain by grain over its colour frame ----
const DISSOLVE_MS = 1100; // how long one photograph takes to dissolve in
const DISSOLVE_CELL = 7; // size of one dissolving grain, in pixels of the frame
const DISSOLVE_VERTEX = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
void main(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  gl_Position = vec4(position, 0.0, 1.0);
  vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}`;
// Every grain gets a random threshold; the grain shows once the progress passes it.
// A little smooth noise is mixed in, so the dissolve breaks up in patches instead of pure static.
const DISSOLVE_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uProgress;
uniform float uSeed;
uniform vec2 uCells;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21) + uSeed);
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float smoothNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec4 color = texture(uTexture, vTextureCoord);
  vec2 cell = floor(vTextureCoord * uCells);
  float n = mix(hash(cell), smoothNoise(cell / 9.0), 0.4);
  float edge = 0.12;
  float shown = smoothstep(n, n + edge, uProgress * (1.0 + edge));
  finalColor = color * shown;
}`;
let dissolveProgram: GlProgram | null = null;
function dissolveFilter(w: number, h: number): Filter {
  dissolveProgram ??= GlProgram.from({ vertex: DISSOLVE_VERTEX, fragment: DISSOLVE_FRAGMENT, name: "vstg-dissolve" });
  return new Filter({
    glProgram: dissolveProgram,
    resources: {
      dissolveUniforms: {
        uProgress: { value: 0, type: "f32" },
        uSeed: { value: Math.random() * 100, type: "f32" },
        uCells: { value: [Math.max(1, w / DISSOLVE_CELL), Math.max(1, h / DISSOLVE_CELL)], type: "vec2<f32>" },
      },
    },
  });
}
const DRAG_TOLERANCE = 6; // pixels moved before a press counts as dragging, not clicking
const TOP_SPACE = 200; // keeps the first pieces below the masthead
const CODE_GAP = 44; // space between the image and its code when a piece is open
const FOCUS_HEIGHT_RATIO = 0.5; // an open piece fills up to half the screen height
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.25;
const INITIAL_ZOOM = 0.72; // the page opens zoomed out, so more pieces are visible at once

// Used by both the canvas and the text panel, so they always agree.
export function focusScale(h: number): number {
  return Math.min(1.5, (window.innerHeight * FOCUS_HEIGHT_RATIO) / h);
}

// Splits a code so that its digits can be set smaller, to match small capitals.
function codeParts(text: string): Node[] {
  return text
    .split(/(\d+)/)
    .filter((part) => part !== "")
    .map((part) => {
      if (/^\d+$/.test(part)) {
        const span = document.createElement("span");
        span.className = "piece-label__digits";
        span.textContent = part;
        return span;
      }
      return document.createTextNode(part);
    });
}

type PieceNode = {
  node: Container; // position, scale and fade
  body: Container; // the piece itself; its blur is trimmed to its frame
  label: HTMLDivElement; // the code, under the piece, as normal HTML text
  blur: BlurFilter;
  piece: Piece;
};
type BlockView = { container: Container; ids: string[] };

// A bracketed label that rewrites itself into its unabbreviated form when touched
// or hovered: it erases back to the shared prefix, types the rest, stays readable
// for a few seconds, then rewrites itself back by itself.
const REWRITE_HOLD_MS = 3500;
function RewriteLabel({ short, full }: { short: string; full: string }) {
  const [text, setText] = useState(short);
  const target = useRef(short);
  const current = useRef(short);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);

  const go = (to: string) => {
    target.current = to;
    if (!timer.current) step();
  };
  const step = () => {
    const goal = target.current;
    const now = current.current;
    if (now === goal) {
      timer.current = null;
      if (goal === full) hold.current = setTimeout(() => go(short), REWRITE_HOLD_MS);
      return;
    }
    current.current = goal.startsWith(now)
      ? goal.slice(0, now.length + 1)
      : now.slice(0, -1);
    setText(current.current);
    timer.current = setTimeout(step, 26);
  };
  const trigger = () => {
    if (hold.current) {
      clearTimeout(hold.current);
      hold.current = null;
    }
    go(full);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (hold.current) clearTimeout(hold.current);
    },
    [],
  );
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (hold.current) clearTimeout(hold.current);
    timer.current = null;
    hold.current = null;
    target.current = short;
    current.current = short;
    setText(short);
  }, [short, full]);

  return (
    <span className="detail__rewrite" onPointerEnter={trigger}>
      {text}
    </span>
  );
}

export default function Collection({
  onFocusChange,
}: {
  onFocusChange: (piece: Piece | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<Piece | null>(null);
  const notifyRef = useRef(onFocusChange);
  notifyRef.current = onFocusChange;

  const detailRef = useRef<HTMLElement>(null);
  const [detailH, setDetailH] = useState(0);
  const detailHRef = useRef(0);

  // Set by the canvas effect so the zoom buttons can reach the plane.
  const zoomRef = useRef<((factor: number) => void) | null>(null);

  useEffect(() => {
    const h = detailRef.current?.offsetHeight ?? 0;
    detailHRef.current = h;
    setDetailH(h);
  }, [focused]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let destroyed = false;
    let app: Application | null = null;
    let removeListeners: (() => void) | null = null;

    // A text layer above the canvas, for the codes under each piece.
    const labelLayer = document.createElement("div");
    labelLayer.className = "piece-labels";
    host.appendChild(labelLayer);

    (async () => {
      // A new order for every visit.
      initArchive(Math.floor(Math.random() * 0xffffffff));
      // Phones start further out, so the neighbouring pieces are visible.
      const startZoom = window.innerWidth < 768 ? 0.4 : INITIAL_ZOOM;
      await document.fonts.load('18px "STIX Two Text"');

      const instance = new Application();
      await instance.init({
        resizeTo: host,
        background: 0xffffff,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });

      if (destroyed) {
        instance.destroy(true, { children: true });
        return;
      }
      app = instance;
      host.appendChild(instance.canvas);

      const stage = instance.stage;
      stage.eventMode = "static";

      // Full-screen white backdrop catches empty-space clicks and drags.
      const backdrop = new Graphics();
      backdrop.eventMode = "static";
      backdrop.cursor = "grab";
      stage.addChildAt(backdrop, 0);
      let backdropW = 0;
      let backdropH = 0;
      function drawBackdrop() {
        const w = instance.screen.width;
        const h = instance.screen.height;
        if (w === backdropW && h === backdropH) return;
        backdropW = w;
        backdropH = h;
        backdrop.clear().rect(0, 0, w, h).fill(0xffffff);
      }
      drawBackdrop();

      // Start with column 0 centred horizontally.
      const world = new Container();
      stage.addChild(world);
      world.position.set(instance.screen.width / 2 - (COLUMN_WIDTH / 2) * startZoom, TOP_SPACE);

      let focusedId: string | null = null;
      let hoveredId: string | null = null;
      let dragging = false;
      let dragDistance = 0;
      let last = { x: 0, y: 0 };
      // Where the plane should rest. Wheel, trackpad and drag move these; the plane eases to them.
      let targetX = world.x;
      let targetY = world.y;
      let scale = startZoom;
      let targetScale = startZoom;
      let lastRangeKey = "";
      const nodes = new Map<string, PieceNode>();
      const blocks = new Map<string, BlockView>();

      let savedView: { x: number; y: number; s: number } | null = null;

      function setFocus(piece: Piece | null) {
        focusedId = piece ? piece.id : null;
        if (piece && !savedView) {
          savedView = { x: targetX, y: targetY, s: targetScale };
        }
        if (!piece) {
          if (savedView) {
            targetX = savedView.x;
            targetY = savedView.y;
            targetScale = savedView.s;
            savedView = null;
          } else {
            targetX = world.x;
            targetY = world.y;
          }
        }
        for (const entry of nodes.values()) {
          entry.body.eventMode = focusedId ? "none" : "static";
        }
        setFocused(piece);
        notifyRef.current(piece);
      }

      // Zoom around a point on screen, so the spot under the cursor stays where it is.
      function zoomAt(factor: number, sx: number, sy: number) {
        if (focusedId) return;
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetScale * factor));
        const wx = (sx - targetX) / targetScale;
        const wy = (sy - targetY) / targetScale;
        targetScale = next;
        targetX = sx - wx * next;
        targetY = sy - wy * next;
      }
      zoomRef.current = (factor: number) => {
        zoomAt(factor, instance.screen.width / 2, instance.screen.height / 2);
      };

      const grainOf = new Map<string, TilingSprite>();

      function createNode(piece: Piece): PieceNode {
        const root = new Container();
        root.pivot.set(piece.w / 2, piece.h / 2);
        root.position.set(piece.x + piece.w / 2, piece.y + piece.h / 2);

        // The piece is its own frame. The mask keeps the blur inside the original size and shape.
        const frame = new Graphics().rect(0, 0, piece.w, piece.h).fill(0xffffff);
        const body = new Container();
        // The mask must be part of the scene, otherwise it is positioned at the screen corner.
        body.addChild(frame);
        body.mask = frame;
        body.cursor = "pointer";
        body.eventMode = focusedId ? "none" : "static";

        // The blur applies to the content only; the mask then trims it to the frame.
        const inner = new Container();
        inner.addChild(new Graphics().rect(0, 0, piece.w, piece.h).fill(piece.color));

        if (piece.kind === "text" && piece.text) {
          const copy = new Text({
            text: piece.text,
            style: {
              fontFamily: "STIX Two Text",
              fontSize: 11.2,
              lineHeight: 17,
              fill: 0x1c1b19,
              wordWrap: true,
              wordWrapWidth: piece.w - 40,
            },
          });
          copy.position.set(20, 20);
          inner.addChild(copy);
        }

        // Real photographs are .webp (or .jpg); the grey .png files are still placeholders and are not loaded.
        if (piece.image && /\.(webp|jpe?g)$/.test(piece.image)) {
          const url = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${piece.image}`;
          Assets.load(url)
            .then((texture) => {
              if (inner.destroyed) return;
              const sprite = new Sprite(texture);
              // Fill the frame, cropped from the centre.
              const k = Math.max(piece.w / texture.width, piece.h / texture.height);
              sprite.scale.set(k);
              sprite.position.set((piece.w - texture.width * k) / 2, (piece.h - texture.height * k) / 2);
              inner.addChildAt(sprite, 1);
              // A fine, neutral film grain over the photograph.
              const grain = new TilingSprite({ texture: grainTexture(), width: piece.w, height: piece.h });
              grain.alpha = GRAIN;
              inner.addChildAt(grain, 2);
              grainOf.set(piece.id, grain);

              // The photograph dissolves in over the colour frame, grain by grain, instead of popping in.
              const dissolve = dissolveFilter(piece.w, piece.h);
              sprite.filters = [dissolve];
              grain.alpha = 0;
              const delay = Math.random() * 250; // pieces that arrive together do not all start in step
              const t0 = performance.now() + delay;
              const run = () => {
                if (inner.destroyed || sprite.destroyed) {
                  instance.ticker.remove(run);
                  return;
                }
                const t = Math.min(1, Math.max(0, (performance.now() - t0) / DISSOLVE_MS));
                const eased = t * t * (3 - 2 * t);
                dissolve.resources.dissolveUniforms.uniforms.uProgress = eased;
                grain.alpha = GRAIN * eased;
                if (t >= 1) {
                  sprite.filters = [];
                  dissolve.destroy();
                  grain.alpha = GRAIN;
                  instance.ticker.remove(run);
                }
              };
              instance.ticker.add(run);
            })
            .catch(() => {});
        }

        const blur = new BlurFilter({ strength: BLUR });
        inner.filters = [blur];
        body.addChild(inner);

        body.on("pointerover", () => {
          hoveredId = piece.id;
        });
        body.on("pointerout", () => {
          if (hoveredId === piece.id) hoveredId = null;
        });
        body.on("pointertap", () => {
          if (dragDistance > DRAG_TOLERANCE) return;
          setFocus(piece);
        });

        root.addChild(body);

        const label = document.createElement("div");
        label.className = "piece-label";
        label.replaceChildren(...codeParts(`[${piece.code}]`));
        labelLayer.appendChild(label);

        return { node: root, body, label, blur, piece };
      }

      function addBlock(c: number, b: number) {
        const container = new Container();
        const ids: string[] = [];
        for (const piece of piecesForBlock(c, b)) {
          const entry = createNode(piece);
          nodes.set(piece.id, entry);
          container.addChild(entry.node);
          ids.push(piece.id);
        }
        world.addChild(container);
        blocks.set(`${c},${b}`, { container, ids });
      }

      function removeBlock(key: string) {
        const block = blocks.get(key);
        if (!block) return;
        for (const id of block.ids) {
          grainOf.delete(id);
          nodes.get(id)?.label.remove();
          nodes.delete(id);
        }
        world.removeChild(block.container);
        block.container.destroy({ children: true });
        blocks.delete(key);
      }

      // Press and hold, then move, to pan. A short press without movement is a click.
      stage.on("pointerdown", (e) => {
        dragging = true;
        dragDistance = 0;
        last = { x: e.global.x, y: e.global.y };
      });
      const endDrag = () => {
        dragging = false;
      };
      stage.on("pointerup", endDrag);
      stage.on("pointerupoutside", endDrag);
      stage.on("globalpointermove", (e) => {
        if (!dragging) return;
        const dx = e.global.x - last.x;
        const dy = e.global.y - last.y;
        last = { x: e.global.x, y: e.global.y };
        dragDistance += Math.abs(dx) + Math.abs(dy);
        if (focusedId) return;
        targetX += dx;
        targetY += dy;
      });
      stage.on("pointertap", (e) => {
        if (e.target === backdrop && focusedId && dragDistance <= DRAG_TOLERANCE) {
          setFocus(null);
        }
      });

      // Wheel and trackpad move the plane in x and y. Ctrl + wheel (or a trackpad pinch) zooms.
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        if (focusedId) return;
        if (e.ctrlKey) {
          const rect = host.getBoundingClientRect();
          zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
          return;
        }
        const unit = e.deltaMode === 1 ? 16 : 1;
        targetX -= e.deltaX * unit;
        targetY -= e.deltaY * unit;
      };
      host.addEventListener("wheel", onWheel, { passive: false });

      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setFocus(null);
        if (!focusedId && (e.key === "+" || e.key === "=")) zoomRef.current?.(1.15);
        if (!focusedId && (e.key === "-" || e.key === "_")) zoomRef.current?.(1 / 1.15);
      };
      const onCloseRequest = () => setFocus(null);
      window.addEventListener("keydown", onKey);
      window.addEventListener("vstg:close", onCloseRequest);
      removeListeners = () => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("vstg:close", onCloseRequest);
        host.removeEventListener("wheel", onWheel);
      };

      instance.ticker.add((ticker) => {
        const dt = ticker.deltaTime;
        const sw = instance.screen.width;
        const sh = instance.screen.height;
        drawBackdrop();

        // An open piece is centred at normal size, with its code and text below it.
        if (focusedId) {
          const entry = nodes.get(focusedId);
          if (entry) {
            const p = entry.piece;
            const imgH = p.h * focusScale(p.h);
            const groupH = imgH + CODE_GAP + detailHRef.current;
            const groupTop = sh / 2 - groupH / 2;
            targetScale = 1;
            targetX = sw / 2 - (p.x + p.w / 2);
            targetY = groupTop + imgH / 2 - (p.y + p.h / 2);
            // The close button sits halfway between the top of the screen and the top of the open piece.
            document.documentElement.style.setProperty("--close-y", `${groupTop / 2}px`);
          }
        }

        // The plane eases toward its targets and rests there.
        const ease = Math.min(1, 0.18 * dt);
        scale += (targetScale - scale) * ease;
        world.scale.set(scale);
        world.x += (targetX - world.x) * ease;
        world.y += (targetY - world.y) * ease;

        for (const [id, entry] of nodes) {
          const isFocus = id === focusedId;
          const k = Math.min(1, 0.12 * dt);

          // While a piece is open, everything else disappears.
          const targetAlpha = focusedId && !isFocus ? 0 : 1;
          entry.node.alpha += (targetAlpha - entry.node.alpha) * k;

          // Public pieces reveal on hover or focus. Private pieces stay blurred.
          const isPublic = entry.piece.visibility === "public";
          // Hover lifts half of the blur; opening the piece removes the rest.
          const targetBlur = !isPublic ? BLUR : isFocus ? 0 : !focusedId && hoveredId === id ? BLUR * 0.5 : BLUR;
          entry.blur.strength += (targetBlur - entry.blur.strength) * Math.min(1, 0.15 * dt);

          const targetNodeScale = isFocus ? focusScale(entry.piece.h) : 1;
          entry.node.scale.set(entry.node.scale.x + (targetNodeScale - entry.node.scale.x) * k);
          // Keep the grain one device pixel fine whatever the zoom.
          grainOf.get(id)?.tileScale.set(1 / (entry.node.scale.x * world.scale.x));

          // The code follows the piece and stays just below its visible edge.
          const s = entry.node.scale.x;
          const cx = entry.piece.x + entry.piece.w / 2;
          const cy = entry.piece.y + entry.piece.h / 2;
          // Positioned on screen, directly below the visible edge of the piece.
          const screenX = world.x + cx * scale;
          const screenY = world.y + (cy + (entry.piece.h * s) / 2) * scale + 10;
          entry.label.style.transform = `translate(${screenX}px, ${screenY}px) translateX(-50%)`;
          entry.label.style.opacity = String(entry.node.alpha);

          // Only what is on screen is drawn, so the total number of pieces does not slow the plane.
          const pl = world.x + (cx - (entry.piece.w * s) / 2) * scale;
          const pt = world.y + (cy - (entry.piece.h * s) / 2) * scale;
          const pr = pl + entry.piece.w * s * scale;
          const pb = pt + entry.piece.h * s * scale + 60;
          const onScreen = pr > -120 && pl < sw + 120 && pb > -120 && pt < sh + 120;
          entry.node.visible = onScreen;
          entry.label.style.display = onScreen ? "" : "none";
        }

        // Stream only the columns and blocks that are on screen, at the current zoom.
        const left = -world.x / scale;
        const top = -world.y / scale;
        const viewW = sw / scale;
        const viewH = sh / scale;
        const minC = Math.floor(left / BLOCK_WIDTH) - 1;
        const maxC = Math.floor((left + viewW) / BLOCK_WIDTH) + 1;
        const minB = Math.floor(top / BLOCK_HEIGHT) - 1;
        const maxB = Math.floor((top + viewH) / BLOCK_HEIGHT) + 1;
        const rangeKey = `${minC},${maxC},${minB},${maxB}`;

        if (rangeKey !== lastRangeKey) {
          lastRangeKey = rangeKey;
          for (const key of [...blocks.keys()]) {
            const [c, b] = key.split(",").map(Number);
            if (c < minC || c > maxC || b < minB || b > maxB) removeBlock(key);
          }
          for (let c = minC; c <= maxC; c++) {
            for (let b = minB; b <= maxB; b++) {
              if (!blocks.has(`${c},${b}`)) addBlock(c, b);
            }
          }
        }
      });
    })();

    return () => {
      destroyed = true;
      removeListeners?.();
      labelLayer.remove();
      zoomRef.current = null;
      app?.destroy(true, { children: true });
    };
  }, []);

  let detailTop = 0;
  if (focused) {
    const imgH = focused.h * focusScale(focused.h);
    const groupH = imgH + CODE_GAP + detailH;
    detailTop = window.innerHeight / 2 - groupH / 2 + imgH + CODE_GAP;
  }

  return (
    <>
      <div ref={hostRef} className="collection-host" />


      {focused && (
        <aside ref={detailRef} className="detail" aria-live="polite" style={{ top: detailTop }}>
          <p className="detail__label">
            <RewriteLabel short="[desc.]" full="[description]" />
          </p>
          <p className="detail__text">{focused.description}</p>
          <p className="detail__label">
            <RewriteLabel short="[f.f. expl.]" full="[failed future explained]" />
          </p>
          <p className="detail__text">{focused.failedFuture}</p>
          {focused.presentEffect && (
            <>
              <p className="detail__label">
                <RewriteLabel
                  short={
                    focused.presentEffect.kind === "documented"
                      ? "[r.c.t.]"
                      : `[r.c.t. — ${focused.presentEffect.kind}]`
                  }
                  full={
                    focused.presentEffect.kind === "documented"
                      ? "[residual contemporary times]"
                      : `[residual contemporary times — ${focused.presentEffect.kind}]`
                  }
                />
              </p>
              <p className="detail__text">{focused.presentEffect.text}</p>
            </>
          )}
        </aside>
      )}
    </>
  );
}
