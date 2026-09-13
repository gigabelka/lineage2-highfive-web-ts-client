import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Vector3,
} from "three";

const DURATION_MS = 550;
const START_INNER = 20;
const START_OUTER = 34;
const END_SCALE = 2.2;
const GROUND_OFFSET = 4;
// World-space overlay convention used elsewhere (visualizer.ts) so the ring draws on top of
// terrain/BSP geometry instead of losing the depth test at this world scale's precision.
const MARKER_RENDER_ORDER = 999;

/**
 * Transient click-to-move destination marker: a ring that shrinks-and-fades over the ground
 * point the player was just sent to. Pure visual effect, no gameplay state - not worth a
 * GameObject/component wiring for a one-shot animation.
 */
export default class MoveTargetMarker extends Group {
  public readonly isMoveTargetMarker = true;

  private readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private age = 0;

  public constructor(point: Vector3) {
    super();

    this.position.copy(point);
    this.position.z += GROUND_OFFSET;

    this.material = new MeshBasicMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
      side: DoubleSide,
    });

    this.mesh = new Mesh(
      new RingGeometry(START_INNER, START_OUTER, 32),
      this.material,
    );
    this.mesh.renderOrder = MARKER_RENDER_ORDER;

    this.add(this.mesh);
  }

  /** Returns false once the animation has finished and the marker should be disposed. */
  public update(deltaTime: number): boolean {
    this.age += deltaTime;

    const t = Math.min(1, this.age / DURATION_MS);

    const scale = 1 + t * (END_SCALE - 1);
    this.mesh.scale.setScalar(scale);
    this.material.opacity = 0.9 * (1 - t);

    return t < 1;
  }

  public dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
