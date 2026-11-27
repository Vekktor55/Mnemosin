/**
 * PixiJS renderer тестовой комнаты P03 (P05-B §3, §4.6).
 *
 * Pixel-art: antialias:false, roundPixels:true, примитивы Graphics (не текстуры).
 * Камера — через Container transform; depth sorting — foot point worldY (+tie-break).
 * Проекция — фронтальная ортографическая 3/4 (top-down oblique, yaw=0°):
 * прямоугольные тайлы пола, фасады стен/дверей вверх по -Y на elevationStep.
 * Рендер-цикл принадлежит GameWorld (независим от WebSocket); здесь только
 * отрисовка по мировым координатам через GridProjection.
 */
import { Application, Assets, Container, Graphics, Sprite } from 'pixi.js';

import { depthKey, depthTieBreak } from '../projection/GridProjection.js';
import type { GridProjection, WorldPoint } from '../projection/GridProjection.js';
import { P03_PROTOTYPE_ROOM } from '../room/p03.js';
import { OBLIQUE_ROOM } from '../room/oblique-room.js';
import type { SceneObject } from '@mnemosin/contracts';

const FLOOR_COLOR = 0x181822;
const FLOOR_ALT_COLOR = 0x1e1e2a;
const WALL_TOP_COLOR = 0x5a3f68;
const WALL_FRONT_COLOR = 0x352640;
const DOOR_OPEN_COLOR = 0x3f9b5a;
const DOOR_CLOSED_COLOR = 0x9b5a3f;
const DOOR_LOCKED_COLOR = 0x7a3f9b;
const PLAYER_OWN_COLOR = 0x7fd07f;
const PLAYER_REMOTE_COLOR = 0xd07f7f;
const PLAYER_SIZE = 0.5; // доля tileWidth
const PLAYER_BODY_HEIGHT_FRACTION = 0.8; // доля tileDepth

interface PlayerSprite {
  readonly sprite: Graphics;
  color: number;
}

export class PixiRenderer {
  private readonly projection: GridProjection;
  private app: Application | null = null;
  private world: Container | null = null;
  private readonly players = new Map<string, PlayerSprite>();
  private readonly sceneObjectSprites: Graphics[] = [];

  constructor(projection: GridProjection) {
    this.projection = projection;
  }

  async init(parent: HTMLElement): Promise<void> {
    const app = new Application();
    await app.init({
      antialias: false,
      background: 0x0a0a10,
      resizeTo: parent,
      roundPixels: true,
    });
    this.app = app;
    this.world = new Container();
    this.world.sortableChildren = true;
    app.stage.addChild(this.world);
    parent.appendChild(app.canvas);
    const USE_BAKED_ROOM = true; // PROTOTYPE-ONLY: переключатель для A/B сравнения
    if (USE_BAKED_ROOM) {
      await this.drawBakedRoom();
    } else {
      this.drawStaticRoom();
    }
    this.centerOn(
      { x: OBLIQUE_ROOM.anchor.cx, y: OBLIQUE_ROOM.anchor.cy },
      { width: parent.clientWidth, height: parent.clientHeight },
    );
    this.render();
  }

  get canvas(): HTMLCanvasElement | null {
    return this.app?.canvas ?? null;
  }

  setSceneObjects(objects: readonly SceneObject[]): void {
    const world = this.world;
    if (world === null) return;
    for (const sprite of this.sceneObjectSprites) sprite.destroy();
    this.sceneObjectSprites.length = 0;
    for (const object of objects) {
      const marker = new Graphics();
      marker.roundPixels = true;
      marker.circle(0, 0, 0.18 * this.projection.config.tileWidth);
      marker.fill(this.doorColor(object.portalState));
      marker.position.set(...this.toPositionArgs(this.projection.worldToScreen(object.position)));
      marker.zIndex = this.sortKey(object.position) + 0.5;
      world.addChild(marker);
      this.sceneObjectSprites.push(marker);
    }
  }

  setPlayer(participantId: string, position: WorldPoint, own: boolean): void {
    let entry = this.players.get(participantId);
    const color = own ? PLAYER_OWN_COLOR : PLAYER_REMOTE_COLOR;
    if (entry === undefined) {
      const sprite = new Graphics();
      sprite.roundPixels = true;
      this.drawPlayerBody(sprite);
      sprite.fill(color);
      this.world?.addChild(sprite);
      entry = { sprite, color };
      this.players.set(participantId, entry);
    } else if (entry.color !== color) {
      entry.sprite.clear();
      this.drawPlayerBody(entry.sprite);
      entry.sprite.fill(color);
      entry.color = color;
    }
    entry.sprite.position.set(...this.toPositionArgs(this.projection.worldToScreen(position)));
    entry.sprite.zIndex = this.sortKey(position);
  }

  removePlayer(participantId: string): void {
    const entry = this.players.get(participantId);
    if (entry === undefined) return;
    entry.sprite.destroy();
    this.players.delete(participantId);
  }

  clearPlayers(): void {
    for (const entry of this.players.values()) entry.sprite.destroy();
    this.players.clear();
  }

  centerOn(position: WorldPoint, viewport: { width: number; height: number }): void {
    if (this.world === null) return;
    const screen = this.projection.worldToScreen(position);
    this.world.position.set(viewport.width / 2 - screen.x, viewport.height / 2 - screen.y);
  }

  render(): void {
    if (this.app === null || this.world === null) return;
    this.app.renderer.render(this.app.stage);
  }

  destroy(): void {
    this.clearPlayers();
    this.app?.destroy(true, { children: true, texture: true });
    this.app = null;
    this.world = null;
  }

  /** Составной sort key: worldY (foot point) + worldX tie-breaker. */
  private sortKey(position: WorldPoint): number {
    return depthKey(position) + depthTieBreak(position) * 1e-4;
  }

  private drawPlayerBody(sprite: Graphics): void {
    const { tileWidth, tileDepth } = this.projection.config;
    const w = PLAYER_SIZE * tileWidth;
    const h = PLAYER_BODY_HEIGHT_FRACTION * tileDepth;
    // Тело растёт вверх от foot point (нижняя кромка = точка контакта с полом).
    sprite.rect(-w * 0.5, -h, w, h);
  }

  private async drawBakedRoom(): Promise<void> {
    const world = this.world;
    if (world === null) return;
    const texture = await Assets.load(OBLIQUE_ROOM.image);
    texture.source.scaleMode = 'nearest'; // pixel-art без размытия
    texture.source.update();
    const room = new Sprite(texture);
    room.anchor.set(0.5); // центр картинки = точка позиционирования
    room.scale.x = -1; // зеркало под screenX = +x·tileWidth
    const center = this.projection.worldToScreen({
      x: OBLIQUE_ROOM.anchor.cx,
      y: OBLIQUE_ROOM.anchor.cy,
    });
    room.position.set(center.x, center.y);
    room.zIndex = -1000; // подложка ниже игроков (sortableChildren уже включён)
    world.addChild(room);
  }

  private drawStaticRoom(): void {
    const world = this.world;
    if (world === null) return;
    const room = P03_PROTOTYPE_ROOM;
    const wall = new Set(room.wallCells.map((cell) => `${cell.gx}:${cell.gy}`));
    for (let gx = room.bounds.minGx; gx <= room.bounds.maxGx; gx += 1) {
      for (let gy = room.bounds.minGy; gy <= room.bounds.maxGy; gy += 1) {
        this.drawFloor(world, gx, gy);
        if (wall.has(`${gx}:${gy}`)) this.drawWall(world, gx, gy);
      }
    }
  }

  private drawFloor(world: Container, gx: number, gy: number): void {
    const tile = new Graphics();
    tile.roundPixels = true;
    const { tileWidth, tileDepth } = this.projection.config;
    tile.rect(gx * tileWidth, gy * tileDepth, tileWidth, tileDepth);
    tile.fill((gx + gy) % 2 === 0 ? FLOOR_COLOR : FLOOR_ALT_COLOR);
    tile.zIndex = gy + gx * 1e-4;
    world.addChild(tile);
  }

  /** Прямоугольный «блок» стены: верхняя грань + фронтальный фасад вверх по -Y. */
  private drawWall(world: Container, gx: number, gy: number): void {
    const { tileWidth, tileDepth, elevationStep } = this.projection.config;

    const top = new Graphics();
    top.roundPixels = true;
    top.rect(gx * tileWidth, gy * tileDepth - elevationStep, tileWidth, tileDepth);
    top.fill(WALL_TOP_COLOR);
    top.zIndex = gy + gx * 1e-4 + 0.1;
    world.addChild(top);

    const front = new Graphics();
    front.roundPixels = true;
    front.rect(gx * tileWidth, gy * tileDepth, tileWidth, elevationStep);
    front.fill(WALL_FRONT_COLOR);
    front.zIndex = gy + gx * 1e-4 + 0.05;
    world.addChild(front);
  }

  private doorColor(portalState: SceneObject['portalState']): number {
    if (portalState === 'open') return DOOR_OPEN_COLOR;
    if (portalState === 'locked') return DOOR_LOCKED_COLOR;
    return DOOR_CLOSED_COLOR;
  }

  private toPositionArgs(point: { x: number; y: number }): [number, number] {
    return [point.x, point.y];
  }
}
