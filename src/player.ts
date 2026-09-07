import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  SphereGeometry,
  Vector3,
} from "three";
import BaseActor from "./base-actor";
import RenderManager from "./rendering/render-manager";
import type { ICollidable } from "./objects/objects";
import RAPIER from "@dimforge/rapier3d";

class Player extends BaseActor implements ICollidable {
  public readonly isPlayer = true;
  public readonly type = "Player";

  protected readonly mesh: THREE.Mesh;
  protected readonly raycaster = new Raycaster();

  protected readonly gravityHelper: THREE.Line;

  protected lastGoodGravityIntersection: THREE.Intersection = null;

  protected velocity = new Vector3();
  protected goToPosition = {
    needsToGo: false,
    position: new Vector3(),
  };

  protected createGravityGeometry() {
    const geometry = new BufferGeometry();
    const position = new Float32BufferAttribute(
      [
        0,
        -this.collisionSize.y * 0.5,
        0,
        0,
        -this.collisionSize.y * 0.5 - 10,
        0,
      ],
      3,
    );

    geometry.setAttribute("position", position);

    return geometry;
  }

  public tryToGo(groundObjects: IntersectionResult[], deltaTime: number) {
    if (!this.goToPosition.needsToGo) {
      const linVel = new Vector3()
        .copy(this.velocity)
        .add(this.rigidbody.translation() as THREE.Vector3);
      this.rigidbody.setNextKinematicTranslation(linVel);

      return;
    }

    const lookPosition = new Vector3()
      .copy(this.goToPosition.position)
      .setY(this.position.y);

    this.lookAt(lookPosition);

    const lookDirection = new Vector3()
      .copy(lookPosition)
      .sub(this.position)
      .normalize();

    const dirVelocity = new Vector3()
      .copy(lookDirection)
      .multiplyScalar(125 * 4)
      .multiplyScalar(deltaTime);
    const linVel = new Vector3()
      .copy(this.velocity)
      .add(dirVelocity)
      .add(this.rigidbody.translation() as THREE.Vector3);

    this.rigidbody.setNextKinematicTranslation(linVel);
  }

  public addPointHelper(
    point: Vector3,
    color: number = 0xff0000,
    time: number = 100,
  ) {
    const renderManager = this.getRenderManager();

    const object = new Mesh(
      new SphereGeometry(10),
      new MeshBasicMaterial({ color }),
    );
    object.position.copy(point);
    renderManager.scene.add(object);
    setTimeout(function () {
      renderManager.scene.remove(object);
      object.material.dispose();
      object.geometry.dispose();
    }, time);
  }

  public getRenderManager() {
    return (global as any).renderManager as RenderManager;
  }

  public getSector() {
    const rm = this.getRenderManager();
    const sector = rm.getSector(this.position);

    return sector;
  }

  public getTerrains() {
    const terrains: THREE.Mesh[] = [];
    const sector = this.getSector();

    sector.traverseVisible((object) => {
      if (!object.name.includes("TerrainSector")) return;
      if (!(object as any).geometry) return;

      terrains.push(object as THREE.Mesh);
    });

    return terrains;
  }
}

export default Player;

type IntersectionResult = {
  position: THREE.Vector3;
  object: ICollidable;
} & RAPIER.RayColliderIntersection;
