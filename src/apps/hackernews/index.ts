/**
 * "hackernews": the Hacker News front page as a reading room in the CAVE.
 *
 * A mock-up of HTML content living in the 3D world. The top thirty stories
 * from the public Hacker News API become cards on a curved wall at reading
 * distance around the viewer, three rows high, in reading order. The wand
 * points at a card (highlighted on every screen, since the pointing is
 * computed from the frame's wand); the primary button opens the story's
 * comments on a larger panel in front; B closes it. The room moves with the
 * CAVE, so it is always around you.
 *
 * Two rasterization tiers for the cards (cards.ts): with Chrome's
 * HTML-in-Canvas API the cards are real DOM laid out with CSS and drawn into
 * a canvas with drawElementImage(); otherwise the same cards are drawn with
 * Canvas 2D text. The status line says which tier is active.
 *
 * Data flows the WebCAVE way: only the controller fetches the API and
 * publishes a compact snapshot (appState.hn: stories, selection, comments);
 * every node builds its textures from that, and "3 hours ago" is computed
 * against the snapshot time so all screens agree.
 */
import * as THREE from "three";
import type { AppContext, AppDefinition, AppSpec, CaveApp } from "../types";
import type { FrameState } from "../../core/protocol";
import { caveToWorld, caveToWorldQuat, navigationMatrix } from "../../core/navigation";
import type { ActionState } from "../../input/actions";
import { detectTier, renderCard, renderComments, type CardLook, type Tier } from "./cards";
import { EMPTY_STATE, fetchComments, fetchTopStories, hnStateOf, type HnState } from "./data";
import { createHnPanel } from "./panel";

const CARD_W = 0.34, CARD_H = 0.28; // meters
const CARD_PX = [512, 420] as const;
const RADIUS = 1.35; // meters from the viewer
const ROWS = 3;
const ROW_Y = [1.92, 1.6, 1.28];
const COMMENTS_W = 1.0, COMMENTS_H = 1.3, COMMENTS_R = 1.0;
const COMMENTS_PX = [1024, 1330] as const;

interface Card {
  id: number;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  texture: THREE.CanvasTexture;
  /** What the texture currently shows, to re-render only on change. */
  key: string;
}

export function createHackerNewsApp(spec: AppSpec, _ctx: AppContext): CaveApp {
  const tier: Tier = spec.options?.tier === "canvas2d" ? "canvas2d" : detectTier();
  const count = typeof spec.options?.count === "number" ? Math.min(60, Math.max(3, spec.options.count)) : 30;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15171c);
  const grid = new THREE.GridHelper(8, 16, 0x2a2f3a, 0x1e222b);
  grid.position.y = 0.001;
  scene.add(grid);
  /** The room follows the CAVE: this group carries the navigation transform. */
  const room = new THREE.Group();
  room.matrixAutoUpdate = false;
  scene.add(room);

  const cards: Card[] = [];
  const cardGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
  let commentsMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  let commentsKey = "";
  let hn: HnState = EMPTY_STATE;
  let pointed = 0;
  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();

  /** Build or rebuild the card meshes for the current story list. */
  function layout() {
    for (const c of cards) {
      room.remove(c.mesh);
      c.texture.dispose();
      c.mesh.material.dispose();
    }
    cards.length = 0;
    const n = hn.stories.length;
    if (!n) return;
    const cols = Math.ceil(n / ROWS);
    const step = (CARD_W + 0.03) / RADIUS; // radians between card centers
    hn.stories.forEach((story, i) => {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const theta = (col - (cols - 1) / 2) * step; // 0 at the front wall, positive to the right
      const texture = new THREE.CanvasTexture(document.createElement("canvas"));
      texture.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({ map: texture }));
      mesh.position.set(RADIUS * Math.sin(theta), ROW_Y[row] ?? 1.6, -RADIUS * Math.cos(theta));
      mesh.rotation.y = -theta; // face the viewer
      mesh.userData.id = story.id;
      room.add(mesh);
      cards.push({ id: story.id, mesh, texture, key: "" });
    });
  }

  /** Re-render the cards whose content or highlight changed. */
  function refreshCards() {
    hn.stories.forEach((story, i) => {
      const c = cards[i];
      if (!c) return;
      const look: CardLook = { pointed: pointed === story.id, selected: hn.selected === story.id };
      const key = `${hn.fetchedAt}|${look.pointed}|${look.selected}`;
      if (key === c.key) return;
      c.key = key;
      c.texture.image = renderCard(tier, story, i + 1, hn.fetchedAt, look, CARD_PX[0], CARD_PX[1]);
      c.texture.needsUpdate = true;
    });
  }

  function refreshComments() {
    const story = hn.stories.find((s) => s.id === hn.selected);
    const list = hn.comments && hn.comments.story === hn.selected ? hn.comments.list : null;
    if (!story || !list) {
      if (commentsMesh) commentsMesh.visible = false;
      commentsKey = "";
      return;
    }
    if (!commentsMesh) {
      const texture = new THREE.CanvasTexture(document.createElement("canvas"));
      texture.colorSpace = THREE.SRGBColorSpace;
      commentsMesh = new THREE.Mesh(new THREE.PlaneGeometry(COMMENTS_W, COMMENTS_H), new THREE.MeshBasicMaterial({ map: texture }));
      commentsMesh.position.set(0, 1.55, -COMMENTS_R);
      room.add(commentsMesh);
    }
    commentsMesh.visible = true;
    const key = `${story.id}|${list.length}`;
    if (key === commentsKey) return;
    commentsKey = key;
    (commentsMesh.material.map as THREE.CanvasTexture).image = renderComments(tier, story, list, hn.fetchedAt, COMMENTS_PX[0], COMMENTS_PX[1]);
    commentsMesh.material.map!.needsUpdate = true;
  }

  const app: CaveApp = {
    name: "hackernews",
    scene,
    ready: Promise.resolve(),
    status: `waiting for stories · cards: ${tier === "html" ? "HTML-in-canvas" : "canvas 2D"}`,
    navigation: { flySpeed: 1, turnSpeed: 1.2, planar: true },
    update(_time, state?: FrameState) {
      const next = hnStateOf(state?.appState);
      const nav = state?.navigation ?? { position: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0 };
      room.position.set(...nav.position);
      room.rotation.set(nav.pitch, nav.yaw, 0);
      room.updateMatrixWorld(true);
      if (next.fetchedAt !== hn.fetchedAt || next.stories.length !== hn.stories.length) {
        hn = next;
        layout();
        app.status = `${hn.stories.length} stories · cards: ${tier === "html" ? "HTML-in-canvas" : "canvas 2D"} · A opens comments, B closes`;
      } else hn = next;
      // Pointing: the wand ray in world space against the cards, the same on every node.
      pointed = 0;
      if (state && cards.length) {
        origin.set(...caveToWorld(nav, state.wand.position));
        q.set(...caveToWorldQuat(nav, state.wand.orientation));
        dir.set(0, 0, -1).applyQuaternion(q);
        raycaster.set(origin, dir);
        const hit = raycaster.intersectObjects(cards.map((c) => c.mesh), false)[0];
        if (hit) pointed = hit.object.userData.id as number;
      }
      refreshCards();
      refreshComments();
    },
    onInput,
    createPanel: (container, pctx) =>
      createHnPanel(container, pctx, {
        refresh: () => void refresh(pctx.send),
        select: (id) => select(id, pctx.send),
        close: () => pctx.send({ hn: { ...hn, selected: 0, comments: undefined } }),
        tier: () => (tier === "html" ? "HTML-in-canvas" : "canvas 2D"),
      }),
    dispose() {
      for (const c of cards) c.texture.dispose();
    },
  };

  // ---- Controller side: fetch and publish --------------------------------------------------
  let fetching = false;
  let prevPrimary = false, prevSecondary = false;
  async function refresh(send: (patch: Record<string, unknown>) => void) {
    if (fetching) return;
    fetching = true;
    try {
      const stories = await fetchTopStories(count);
      send({ hn: { fetchedAt: Math.floor(Date.now() / 1000), stories, selected: 0 } satisfies HnState });
    } catch (e) {
      app.status = `fetch failed: ${(e as Error).message}`;
    } finally {
      fetching = false;
    }
  }
  function select(id: number, send: (patch: Record<string, unknown>) => void) {
    send({ hn: { ...hn, selected: id, comments: undefined } });
    void fetchComments(id).then((list) => {
      send({ hn: { ...hn, selected: id, comments: { story: id, list } } });
    });
  }
  function onInput(actions: ActionState, _dt: number, state: FrameState, send: (patch: Record<string, unknown>) => void) {
    // First controller to see an empty state fetches the front page.
    if (!hnStateOf(state.appState).stories.length && !fetching && state.time > 0.5) void refresh(send);
    if (actions.buttons.primary && !prevPrimary && pointed) select(pointed, send);
    if (actions.buttons.secondary && !prevSecondary && hn.selected) send({ hn: { ...hn, selected: 0, comments: undefined } });
    prevPrimary = actions.buttons.primary;
    prevSecondary = actions.buttons.secondary;
  }

  (app as CaveApp & { debug: unknown }).debug = { get hn() { return hn; }, get pointed() { return pointed; }, tier, cards };
  return app;
}

export default {
  name: "hackernews",
  description: "Hacker News front page as a curved wall of cards around the viewer; DOM cards via HTML-in-canvas when available, Canvas 2D otherwise",
  create: (spec, ctx) => createHackerNewsApp(spec, ctx),
} satisfies AppDefinition;
