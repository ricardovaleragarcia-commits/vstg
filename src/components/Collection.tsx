"use client";

import { useEffect, useRef, useState } from "react";
import { Application, Assets, BlurFilter, Container, Graphics, Rectangle, Sprite, Texture, TilingSprite } from "pixi.js";
import { initArchive, CELL_H, CELL_W, pieceAt, type Piece } from "@/lib/demo-collection";

// Pieces rest in an already blurred copy (made by scripts/image-versions.mjs), so the browser
// does not compute hundreds of blurs while the plane moves. Hover brings in the sharp copy,
// softened by this much; opening a piece removes the rest.
const BLUR = 14;

// Three copies of every image: tiny and blurred for the plane, medium for hover, the original for an open piece.
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
type Variant = "b" | "m" | "full";
function imageUrl(image: string, variant: Variant): string {
  if (variant === "full") return BASE + image;
  return BASE + image.replace(/\/([^/]+)\.(webp|jpe?g)$/i, `/${variant}/$1.webp`);
}

// A view of the texture cropped from the centre to the frame's proportions, so no mask is needed.
function coverTexture(texture: Texture, w: number, h: number): Texture {
  const tw = texture.width;
  const th = texture.height;
  const k = Math.max(w / tw, h / th);
  const cw = w / k;
  const ch = h / k;
  return new Texture({ source: texture.source, frame: new Rectangle((tw - cw) / 2, (th - ch) / 2, cw, ch) });
}
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

// ---- Appearance: each photograph comes out of a fog over its colour frame ----
const APPEAR_MS = 1300; // how long one photograph takes to settle
const APPEAR_BLUR = 22; // extra blur at the start, on top of the blurred copy
const FRAME_FADE_MS = 900; // how long a colour frame takes to fade in before its photograph arrives

const DRAG_TOLERANCE = 6; // pixels moved before a press counts as dragging, not clicking
const TOP_SPACE = 200; // keeps the first pieces below the masthead
const CODE_GAP = 44; // space between the image and its code when a piece is open
const FOCUS_HEIGHT_RATIO = 0.5; // an open piece fills up to half the screen height
const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.25;
const INITIAL_ZOOM = 0.85; // the page opens zoomed out, so more pieces are visible at once

// ---- Glide: opening or closing a piece is one calm motion, longer the further the piece is ----
const GLIDE_MIN_MS = 650;
const GLIDE_MAX_MS = 1100;
const GLIDE_MS_PER_PX = 0.3; // extra time per pixel the plane has to travel
const GLIDE_FADE_RATE = 0.085; // fade, blur and size ease at this rate while the plane glides (normally 0.12)
// Same curve as the long CSS transitions of the site (cubic-bezier(0.65, 0, 0.35, 1)).
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---- Drag: letting go of a quick drag throws the plane a little further ----
const PAN_EASE = 0.18;
const WHEEL_EASE = 0.09; // trackpad and wheel: the plane trails the fingers a little, like smooth scrolling
const THROW_EASE = 0.07; // softer easing while the plane coasts after a throw
const THROW_MS = 260; // how far a throw carries: speed (px/ms) times this
const THROW_MAX_PX = 1200;
const THROW_MIN_SPEED = 0.3; // px/ms below which letting go does not throw

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
  body: Container; // the piece itself
  frame: Graphics; // the piece's own size and shape; used as a mask only while a live blur is on
  swatch: Graphics; // the predominant colour, shown while the photograph arrives
  frameStart: number;
  label: HTMLDivElement; // the code, under the piece, as normal HTML text
  labelShown: boolean;
  grain: TilingSprite | null;
  sharp: Sprite | null; // medium copy on hover, the original once opened
  sharpLevel: 0 | 1 | 2; // 0 none requested, 1 medium, 2 original
  sharpReady: boolean;
  reveal: number; // 0 blurred copy only, 1 sharp copy fully in
  liveBlur: BlurFilter | null; // only on the piece under the cursor
  appearing: boolean; // true while the photograph comes out of its fog
  piece: Piece;
};

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
      const startZoom = window.innerWidth < 768 ? 0.7 : INITIAL_ZOOM;
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
      world.position.set(instance.screen.width / 2 - (CELL_W / 2) * startZoom, TOP_SPACE);

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

      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // The glide: while it runs, the camera follows a timed curve instead of the quick pan easing.
      let glide: { t0: number; dur: number; x0: number; y0: number; s0: number } | null = null;
      let glideRequested = false;
      let panEase = PAN_EASE;
      // Speed of the drag, in px/ms, to throw the plane when it is let go.
      let vx = 0;
      let vy = 0;
      let lastMove = 0;

      let savedView: { x: number; y: number; s: number } | null = null;
      let navigated = false; // true once the reader has moved between pieces with the arrow keys

      // Stops a glide or a throw where the plane is, so a new touch takes hold of it.
      // `everything` also stops a coast or a smooth-scroll tail (a press); the wheel only takes over a glide.
      function catchPlane(everything: boolean) {
        if (!glide && !(everything && panEase !== PAN_EASE)) return;
        glide = null;
        glideRequested = false;
        panEase = PAN_EASE;
        targetX = world.x;
        targetY = world.y;
        targetScale = scale;
      }

      function setFocus(piece: Piece | null) {
        const previous = focusedId ? nodes.get(focusedId)?.piece : null;
        focusedId = piece ? piece.id : null;
        glideRequested = !!(piece || previous); // the ticker works out the distance and starts the glide
        panEase = PAN_EASE;
        if (piece && !savedView) {
          savedView = { x: targetX, y: targetY, s: targetScale };
        }
        if (!piece) {
          if (savedView && navigated && previous) {
            // After moving between pieces, close where the last one was, not back at the first.
            targetX = instance.screen.width / 2 - (previous.x + previous.w / 2) * savedView.s;
            targetY = instance.screen.height / 2 + 40 - (previous.y + previous.h / 2) * savedView.s;
            targetScale = savedView.s;
          } else if (savedView) {
            targetX = savedView.x;
            targetY = savedView.y;
            targetScale = savedView.s;
          } else {
            targetX = world.x;
            targetY = world.y;
          }
          savedView = null;
          navigated = false;
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

      function createNode(piece: Piece): PieceNode {
        const root = new Container();
        root.pivot.set(piece.w / 2, piece.h / 2);
        root.position.set(piece.x + piece.w / 2, piece.y + piece.h / 2);

        const body = new Container();
        body.hitArea = new Rectangle(0, 0, piece.w, piece.h);
        body.cursor = "pointer";
        body.eventMode = focusedId ? "none" : "static";
        const frame = new Graphics().rect(0, 0, piece.w, piece.h).fill(0xffffff);
        body.addChild(frame);

        // The colour frame fades in softly instead of appearing as a hard block (eased in the ticker).
        const swatch = new Graphics().rect(0, 0, piece.w, piece.h).fill(piece.color);
        swatch.alpha = 0;
        body.addChild(swatch);
        const frameStart = performance.now() + Math.random() * 400;

        const label = document.createElement("div");
        label.className = "piece-label";
        label.style.display = "none";
        label.replaceChildren(...codeParts(`[${piece.code}]`));
        labelLayer.appendChild(label);

        const entry: PieceNode = {
          node: root,
          body,
          frame,
          swatch,
          frameStart,
          label,
          labelShown: false,
          grain: null,
          sharp: null,
          sharpLevel: 0,
          sharpReady: false,
          reveal: 0,
          liveBlur: null,
          appearing: false,
          piece,
        };

        // The tiny blurred copy: a couple of kilobytes, so the whole plane arrives almost at once.
        if (piece.image && /\.(webp|jpe?g)$/.test(piece.image)) {
          Assets.load(imageUrl(piece.image, "b"))
            .then((texture: Texture) => {
              if (body.destroyed) return;
              const sprite = new Sprite(coverTexture(texture, piece.w, piece.h));
              sprite.width = piece.w;
              sprite.height = piece.h;
              body.addChildAt(sprite, 2);
              // A fine, neutral film grain over the photograph.
              const grain = new TilingSprite({ texture: grainTexture(), width: piece.w, height: piece.h });
              body.addChild(grain);
              entry.grain = grain;

              // The photograph comes out of a fog over its colour frame: it fades in while its extra
              // blur settles. The frame trims the fog, so it stays inside the piece.
              const fog = new BlurFilter({ strength: APPEAR_BLUR, quality: 2 });
              sprite.filters = [fog];
              sprite.alpha = 0;
              grain.alpha = 0;
              entry.appearing = true;
              body.mask = frame;
              const delay = Math.random() * 250; // pieces that arrive together do not all start in step
              // The photograph waits until its colour frame is mostly in, so the two do not arrive at once.
              const t0 = Math.max(performance.now() + delay, frameStart + FRAME_FADE_MS * 0.6);
              const run = () => {
                if (sprite.destroyed) {
                  instance.ticker.remove(run);
                  return;
                }
                const t = Math.min(1, Math.max(0, (performance.now() - t0) / APPEAR_MS));
                const eased = 1 - Math.pow(1 - t, 3);
                sprite.alpha = Math.min(1, eased * 1.4);
                fog.strength = APPEAR_BLUR * (1 - eased);
                grain.alpha = GRAIN * eased;
                if (t >= 1) {
                  sprite.filters = [];
                  fog.destroy();
                  sprite.alpha = 1;
                  grain.alpha = GRAIN;
                  entry.appearing = false;
                  if (!entry.liveBlur) body.mask = null;
                  instance.ticker.remove(run);
                }
              };
              instance.ticker.add(run);
            })
            .catch(() => {});
        }

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
        return entry;
      }

      // Loads the sharp copy only when it is needed: the medium one on hover, the original once opened.
      function requestSharp(entry: PieceNode, level: 1 | 2) {
        const image = entry.piece.image;
        if (!image || entry.sharpLevel >= level) return;
        entry.sharpLevel = level;
        Assets.load(imageUrl(image, level === 2 ? "full" : "m"))
          .then((texture: Texture) => {
            if (entry.body.destroyed) return;
            const { w, h } = entry.piece;
            const cropped = coverTexture(texture, w, h);
            if (entry.sharp) {
              // The original replaces the medium copy in place, once it is ready.
              if (level === 2 || !entry.sharpReady) entry.sharp.texture = cropped;
            } else {
              const sprite = new Sprite(cropped);
              sprite.alpha = 0;
              sprite.visible = false;
              // Above the blurred copy, under the grain.
              const at = entry.grain ? entry.body.getChildIndex(entry.grain) : entry.body.children.length;
              entry.body.addChildAt(sprite, at);
              entry.sharp = sprite;
            }
            entry.sharp.width = w;
            entry.sharp.height = h;
            entry.sharpReady = true;
          })
          .catch(() => {
            entry.sharpLevel = (level - 1) as 0 | 1;
          });
      }

      function removeNode(id: string) {
        const entry = nodes.get(id);
        if (!entry) return;
        entry.label.remove();
        entry.liveBlur?.destroy();
        world.removeChild(entry.node);
        entry.node.destroy({ children: true });
        nodes.delete(id);
        if (hoveredId === id) hoveredId = null;
      }

      // Press and hold, then move, to pan. A short press without movement is a click.
      stage.on("pointerdown", (e) => {
        dragging = true;
        dragDistance = 0;
        last = { x: e.global.x, y: e.global.y };
        vx = vy = 0;
        lastMove = performance.now();
        if (!focusedId) catchPlane(true);
      });
      const endDrag = () => {
        // A quick drag, let go while still moving, carries the plane a little further.
        if (dragging && !focusedId && dragDistance > DRAG_TOLERANCE && performance.now() - lastMove < 80) {
          const speed = Math.hypot(vx, vy);
          if (speed > THROW_MIN_SPEED) {
            const k = Math.min(THROW_MS, THROW_MAX_PX / speed);
            targetX += vx * k;
            targetY += vy * k;
            panEase = THROW_EASE;
          }
        }
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
        const now = performance.now();
        const elapsed = Math.max(1, now - lastMove);
        lastMove = now;
        vx = vx * 0.6 + (dx / elapsed) * 0.4;
        vy = vy * 0.6 + (dy / elapsed) * 0.4;
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
        catchPlane(false);
        panEase = WHEEL_EASE;
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

      // With a piece open, the arrow keys move to the nearest piece in that direction.
      function stepFocus(key: string) {
        const current = focusedId ? nodes.get(focusedId)?.piece : null;
        if (!current) return;
        const dir =
          key === "ArrowRight" ? [1, 0] : key === "ArrowLeft" ? [-1, 0] : key === "ArrowDown" ? [0, 1] : key === "ArrowUp" ? [0, -1] : null;
        if (!dir) return;
        const cx = current.x + current.w / 2;
        const cy = current.y + current.h / 2;
        let best: Piece | null = null;
        let bestScore = Infinity;
        for (const { piece } of nodes.values()) {
          if (piece.id === current.id || piece.code === current.code) continue;
          const dx = piece.x + piece.w / 2 - cx;
          const dy = piece.y + piece.h / 2 - cy;
          const along = dx * dir[0] + dy * dir[1];
          const across = Math.abs(dx * dir[1] - dy * dir[0]);
          if (along < 40 || across > along * 2.5) continue;
          const score = along + across * 2; // straight ahead beats far off to the side
          if (score < bestScore) {
            bestScore = score;
            best = piece;
          }
        }
        if (best) {
          navigated = true;
          setFocus(best);
        }
      }

      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setFocus(null);
        if (focusedId && e.key.startsWith("Arrow")) {
          e.preventDefault();
          stepFocus(e.key);
        }
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

        // Opening or closing a piece: one calm glide, longer the further the plane has to travel.
        const now = performance.now();
        if (glideRequested) {
          glideRequested = false;
          const travel = Math.hypot(targetX - world.x, targetY - world.y) + Math.abs(targetScale - scale) * 400;
          const dur = reduceMotion ? 250 : Math.min(GLIDE_MAX_MS, GLIDE_MIN_MS + travel * GLIDE_MS_PER_PX);
          glide = { t0: now, dur, x0: world.x, y0: world.y, s0: scale };
        }

        if (glide) {
          // The targets can still move a little (the text under an open piece is measured after it appears),
          // so the glide always aims at where they are now.
          const e = easeInOutCubic(Math.min(1, (now - glide.t0) / glide.dur));
          scale = glide.s0 + (targetScale - glide.s0) * e;
          world.scale.set(scale);
          world.x = glide.x0 + (targetX - glide.x0) * e;
          world.y = glide.y0 + (targetY - glide.y0) * e;
          if (now - glide.t0 >= glide.dur) glide = null;
        } else {
          // Dragging and the wheel: the plane eases toward its targets and rests there.
          const ease = Math.min(1, panEase * dt);
          scale += (targetScale - scale) * ease;
          world.scale.set(scale);
          world.x += (targetX - world.x) * ease;
          world.y += (targetY - world.y) * ease;
          // A throw has settled once the plane is on its target; the quick easing comes back.
          if (panEase !== PAN_EASE && Math.abs(targetX - world.x) < 0.5 && Math.abs(targetY - world.y) < 0.5) {
            panEase = PAN_EASE;
          }
        }

        const gliding = glide !== null;
        for (const [id, entry] of nodes) {
          const isFocus = id === focusedId;
          const k = Math.min(1, (gliding ? GLIDE_FADE_RATE : 0.12) * dt);

          // While a piece is open, everything else disappears.
          const targetAlpha = focusedId && !isFocus ? 0 : 1;
          entry.node.alpha += (targetAlpha - entry.node.alpha) * k;

          // Public pieces reveal on hover or focus. Private pieces stay blurred.
          const isPublic = entry.piece.visibility === "public";
          const wantSharp = isPublic && (isFocus || (!focusedId && hoveredId === id));
          if (wantSharp) requestSharp(entry, isFocus ? 2 : 1);
          const revealTarget = wantSharp && entry.sharpReady ? 1 : 0;
          entry.reveal += (revealTarget - entry.reveal) * Math.min(1, (gliding ? 0.11 : 0.15) * dt);
          if (entry.sharp) {
            const shown = entry.reveal > 0.004;
            entry.sharp.visible = shown;
            entry.sharp.alpha = entry.reveal;
            // Hover keeps half of the blur, live, on this one piece only; opening the piece removes it.
            const blurTarget = isFocus ? 0 : BLUR * 0.5;
            if (shown && (blurTarget > 0 || (entry.liveBlur && entry.liveBlur.strength > 0.1))) {
              if (!entry.liveBlur) {
                entry.liveBlur = new BlurFilter({ strength: BLUR });
                entry.sharp.filters = [entry.liveBlur];
                entry.body.mask = entry.frame; // keeps the live blur inside the frame
              }
              entry.liveBlur.strength += (blurTarget - entry.liveBlur.strength) * Math.min(1, (gliding ? 0.11 : 0.15) * dt);
            } else if (entry.liveBlur) {
              entry.sharp.filters = [];
              if (!entry.appearing) entry.body.mask = null;
              entry.liveBlur.destroy();
              entry.liveBlur = null;
            }
          }

          // The colour frame fades in.
          if (entry.swatch.alpha < 1) {
            const t = Math.min(1, Math.max(0, (now - entry.frameStart) / FRAME_FADE_MS));
            entry.swatch.alpha = t * t * (3 - 2 * t);
          }

          const targetNodeScale = isFocus ? focusScale(entry.piece.h) : 1;
          entry.node.scale.set(entry.node.scale.x + (targetNodeScale - entry.node.scale.x) * k);
          // Keep the grain one device pixel fine whatever the zoom.
          entry.grain?.tileScale.set(1 / (entry.node.scale.x * world.scale.x));

          // Only what is on screen is drawn, so the total number of pieces does not slow the plane.
          const s = entry.node.scale.x;
          const cx = entry.piece.x + entry.piece.w / 2;
          const cy = entry.piece.y + entry.piece.h / 2;
          const pl = world.x + (cx - (entry.piece.w * s) / 2) * scale;
          const pt = world.y + (cy - (entry.piece.h * s) / 2) * scale;
          const pr = pl + entry.piece.w * s * scale;
          const pb = pt + entry.piece.h * s * scale + 60;
          const onScreen = pr > -120 && pl < sw + 120 && pb > -120 && pt < sh + 120;
          entry.node.visible = onScreen;
          if (onScreen !== entry.labelShown) {
            entry.labelShown = onScreen;
            entry.label.style.display = onScreen ? "" : "none";
          }
          if (!onScreen) continue;

          // The code follows the piece, on screen, directly below its visible edge.
          const screenX = world.x + cx * scale;
          const screenY = world.y + (cy + (entry.piece.h * s) / 2) * scale + 10;
          entry.label.style.transform = `translate(${screenX}px, ${screenY}px) translateX(-50%)`;
          entry.label.style.opacity = String(entry.node.alpha);
        }

        // Stream only the grid cells on screen, plus a margin, so new pieces are ready before they appear.
        const left = -world.x / scale;
        const top = -world.y / scale;
        const viewW = sw / scale;
        const viewH = sh / scale;
        const padX = Math.max(CELL_W, viewW * 0.3);
        const padY = Math.max(CELL_H, viewH * 0.3);
        const minX = Math.floor((left - padX) / CELL_W);
        const maxX = Math.floor((left + viewW + padX) / CELL_W);
        const minY = Math.floor((top - padY) / CELL_H);
        const maxY = Math.floor((top + viewH + padY) / CELL_H);
        const rangeKey = `${minX},${maxX},${minY},${maxY}`;

        if (rangeKey !== lastRangeKey) {
          lastRangeKey = rangeKey;
          for (const id of [...nodes.keys()]) {
            if (id === focusedId) continue;
            const [gx, gy] = id.split(":").map(Number);
            if (gx < minX || gx > maxX || gy < minY || gy > maxY) removeNode(id);
          }
          for (let gx = minX; gx <= maxX; gx++) {
            for (let gy = minY; gy <= maxY; gy++) {
              const id = `${gx}:${gy}`;
              if (nodes.has(id)) continue;
              const piece = pieceAt(gx, gy);
              if (!piece) continue;
              const entry = createNode(piece);
              nodes.set(id, entry);
              world.addChild(entry.node);
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
        <aside key={focused.id} ref={detailRef} className="detail" aria-live="polite" style={{ top: detailTop }}>
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
                      ? "[f.f. eff.]"
                      : `[f.f. eff. — ${focused.presentEffect.kind}]`
                  }
                  full={
                    focused.presentEffect.kind === "documented"
                      ? "[failed future effect]"
                      : `[failed future effect — ${focused.presentEffect.kind}]`
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
