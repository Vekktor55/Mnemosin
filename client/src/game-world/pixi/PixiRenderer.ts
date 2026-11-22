/**
 * PixiJS renderer тестовой комнаты P03 (P05-B §3, §4.6).
 *
 * Pixel-art: antialias:false, roundPixels:true, примитивы Graphics (не текстуры).
 * Камера — через Container transform; depth sorting — foot point (worldX+worldY).
 * Рендер-цикл принадлежит GameWorld (независим от WebSocket); здесь только
 * отрисовка по мировым координатам через GridProjection.
 */
import { Application, Container, Graphics } from 'pixi.js';

import { depthKey } from '../projection/GridProjection.js';
import type { GridProjection, WorldPoint } from '../projection/GridProjection.js';
import { P03_PROTOTYPE_ROOM } from '../room/p03.js';
import type { SceneObject } from '@mnemosin/contracts';

const FLOOR_COLOR = 0x181822;
const FLOOR_ALT_COLOR = 0x1e1e2a;
const WALL_COLOR = 0x4a3458;
const WALL_TOP_COLOR = 0x5a3f68;
const DOOR_OPEN_COLOR = 0x3f9b5a;
const DOOR_CLOSED_COLOR = 0x9b5a3f;
const DOOR_LOCKED_COLOR = 0x7a3f9b;
const PLAYER_OWN_COLOR = 0x7fd07f;
const PLAYER_REMOTE_COLOR = 0xd07f7f;
const PLAYER_SIZE = 0.4;

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
    this.drawStaticRoom();
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
      marker.circle(0, 0, 0.18 * this.projection.config.halfTileWidth);
      marker.fill(this.doorColor(object.portalState));
      marker.position.set(...this.toPositionArgs(this.projection.worldToScreen(object.position)));
      marker.zIndex = depthKey(object.position) + 0.5;
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
      sprite.rect(
        -PLAYER_SIZE * 0.5 * this.projection.config.halfTileWidth,
        -PLAYER_SIZE * this.projection.config.halfTileHeight,
        PLAYER_SIZE * this.projection.config.halfTileWidth,
        PLAYER_SIZE * this.projection.config.halfTileHeight * 2,
      );
      sprite.fill(color);
      this.world?.addChild(sprite);
      entry = { sprite, color };
      this.players.set(participantId, entry);
    } else if (entry.color !== color) {
      entry.sprite.clear();
      entry.sprite.rect(
        -PLAYER_SIZE * 0.5 * this.projection.config.halfTileWidth,
        -PLAYER_SIZE * this.projection.config.halfTileHeight,
        PLAYER_SIZE * this.projection.config.halfTileWidth,
        PLAYER_SIZE * this.projection.config.halfTileHeight * 2,
      );
      entry.sprite.fill(color);
      entry.color = color;
    }
    entry.sprite.position.set(...this.toPositionArgs(this.projection.worldToScreen(position)));
    entry.sprite.zIndex = depthKey(position);
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

  private drawStaticRoom(): void {
    const world = this.world;
    if (world === null) return;
    const room = P03_PROTOTYPE_ROOM;
    const wall = new Set(room.wallCells.map((cell) => `${cell.gx}:${cell.gy}`));
    for (let gx = room.bounds.minGx; gx <= room.bounds.maxGx; gx += 1) {
      for (let gy = room.bounds.minGy; gy <= room.bounds.maxGy; gy += 1) {
        if (wall.has(`${gx}:${gy}`)) {
          this.drawWall(world, gx, gy);
        } else {
          this.drawFloor(world, gx, gy);
        }
      }
    }
  }

  private drawFloor(world: Container, gx: number, gy: number): void {
    const tile = new Graphics();
    tile.roundPixels = true;
    tile.poly(this.diamondPoints(gx, gy, 0));
    tile.fill((gx + gy) % 2 === 0 ? FLOOR_COLOR : FLOOR_ALT_COLOR);
    tile.zIndex = gx + gy;
    world.addChild(tile);
  }

  private drawWall(world: Container, gx: number, gy: number): void {
    const base = new Graphics();
    base.roundPixels = true;
    base.poly(this.diamondPoints(gx, gy, 0));
    base.fill(WALL_COLOR);
    base.zIndex = gx + gy;
    world.addChild(base);

    const top = new Graphics();
    top.roundPixels = true;
    top.poly(this.diamondPoints(gx, gy, 0.5));
    top.fill(WALL_TOP_COLOR);
    top.zIndex = gx + gy + 0.1;
    world.addChild(top);

    const side = new Graphics();
    side.roundPixels = true;
    const ground = this.diamondPoints(gx, gy, 0);
    const raised = this.diamondPoints(gx, gy, 0.5);
    side.poly([ground[2], ground[3], raised[2], raised[3], raised[4], raised[5], ground[4], ground[5]]);
    side.fill(0x352640);
    side.zIndex = gx + gy + 0.05;
    world.addChild(side);
  }

  /** Четыре угла ромба клетки в экранных координатах (top/right/bottom/left). */
  private diamondPoints(
    gx: number,
    gy: number,
    elevation: number,
  ): [number, number, number, number, number, number, number, number] {
    void this.projection.config;
    const top = this.projection.worldToScreen({ x: gx + 0.5, y: gy }, elevation);
    const right = this.projection.worldToScreen({ x: gx + 1, y: gy + 0.5 }, elevation);
    const bottom = this.projection.worldToScreen({ x: gx + 0.5, y: gy + 1 }, elevation);
    const left = this.projection.worldToScreen({ x: gx, y: gy + 0.5 }, elevation);
    return [top.x, top.y, right.x, right.y, bottom.x, bottom.y, left.x, left.y];
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
