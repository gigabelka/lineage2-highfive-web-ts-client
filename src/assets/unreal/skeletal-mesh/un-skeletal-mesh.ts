import { BufferValue, UObject } from "@l2js/core";
import getTypedArrayConstructor from "@client/utils/typed-arrray-constructor";
import { generateUUID } from "three/src/math/MathUtils.js";
import FArray, {
  FArrayLazy,
  FPrimitiveArray,
  FPrimitiveArrayLazy,
} from "@l2js/core/unreal/un-array";
import FCoords from "../un-coords";
import ULodMesh from "../un-lod-mesh";
import FQuaternion, { FAxis } from "../un-quaternion";
import FRawIndexBuffer from "../un-raw-index-buffer";
import FVector from "../un-vector";
import { FIndexArray } from "@l2js/core/unreal/un-array";

type SkeletalMeshDecodeResult_T = {
  object: GD.ISkinnedMeshObjectDecodeInfo;
  geometry: GD.IGeometryDecodeInfo;
  material: GD.IMaterialGroupDecodeInfo;
};

/* Serialize-only helpers (FArray elements, direct `new`). They must NOT extend UObject:
   core's UObject constructor calls `makeLayout()`, whose base implementation throws
   ("Layout for '<X>' must be overloaded by the package") - only classes the package
   builds dynamically (via UStruct.buildClass) get a working layout. */
/* Plain structs, used *as array elements*.
 *
 * `FVector` and `FCoords` are UObjects whose layout comes from the package, so an array of them
 * cannot be constructed here - `FArray.load` builds elements with `createElement`, and without a
 * package-supplied layout that throws "Layout for 'FVector' must be overloaded by the package".
 * These carry the same bytes (3 floats, and 4 vectors) with no such dependency, which is also
 * what the reference implementation used. */
class FMeshVector implements C.IConstructable {
  public x: number;
  public y: number;
  public z: number;

  public load(pkg: C.APackage): this {
    this.x = pkg.read("float");
    this.y = pkg.read("float");
    this.z = pkg.read("float");

    return this;
  }
}

class FMeshCoords implements C.IConstructable {
  public origin = new FMeshVector();
  public xAxis = new FMeshVector();
  public yAxis = new FMeshVector();
  public zAxis = new FMeshVector();

  public load(pkg: C.APackage): this {
    this.origin.load(pkg);
    this.xAxis.load(pkg);
    this.yAxis.load(pkg);
    this.zAxis.load(pkg);

    return this;
  }
}

class FWeightIndex implements C.IConstructable {
  public boneInfIndices: FPrimitiveArray<"uint16"> = new FPrimitiveArray(
    BufferValue.uint16,
  );
  public startBoneInf: number;

  public load(pkg: C.APackage): this {
    this.boneInfIndices.load(pkg);
    this.startBoneInf = pkg.read("uint32");

    return this;
  }
}

class FBoneInfluence implements C.IConstructable {
  public boneWeight: number;
  public boneIndex: number;

  public load(pkg: C.APackage): this {
    this.boneWeight = pkg.read("uint16");
    this.boneIndex = pkg.read("uint16");

    return this;
  }
}

class FJointPos implements C.IConstructable {
  public rotation: FQuaternion;
  public position: FVector;
  public scale: FVector;
  public length: number;

  public load(pkg: C.APackage): this {
    this.rotation = FQuaternion.make().load(pkg);
    this.position = FVector.make().load(pkg);
    this.length = pkg.read("float");
    this.scale = FVector.make().load(pkg);

    this.scale.set(1, 1, 1);

    return this;
  }
}

class FMeshBone implements C.IConstructable {
  public boneName: string;
  public flags: number;
  public bonePos = new FJointPos();
  public numChildren: number;
  public parentIndex: number;

  public load(pkg: C.APackage): this {
    const nameIndex = pkg.read("compat32");
    this.boneName = pkg.nameTable[nameIndex].name as string;

    this.flags = pkg.read("uint32");

    this.bonePos.load(pkg);

    this.numChildren = pkg.read("uint32");
    this.parentIndex = pkg.read("uint32");

    return this;
  }
}

class FMeshNorm implements C.IConstructable {
  public x = 10;
  public y = 10;
  public z = 10;

  public v: number;

  public load(pkg: C.APackage): this {
    this.v = pkg.read("uint32");

    return this;
  }
}

class FSkinPoint implements C.IConstructable {
  public point: FVector;
  public normal: FMeshNorm;

  public load(pkg: C.APackage): this {
    this.point = FVector.make().load(pkg);
    this.normal = new FMeshNorm().load(pkg);

    return this;
  }
}

class FSkelMeshSection implements C.IConstructable {
  public materialIndex: number;
  public minStreamIndex: number;
  public minWedgeIndex: number;
  public maxWedgeIndex: number;
  public numStreamIndices: number;
  public boneIndex: number;
  public fE: number;
  public firstFace: number;
  public numFaces: number;

  public load(pkg: C.APackage): this {
    this.materialIndex = pkg.read("int16");

    this.minStreamIndex = pkg.read("int16");

    this.minWedgeIndex = pkg.read("int16");
    this.maxWedgeIndex = pkg.read("int16");

    this.numStreamIndices = pkg.read("int16");

    this.boneIndex = pkg.read("int16");
    this.fE = pkg.read("int16");
    this.firstFace = pkg.read("int16");
    this.numFaces = pkg.read("int16");

    return this;
  }
}

class FAnimMeshVertex implements C.IConstructable {
  public position: FVector;
  public normal: FVector;
  public texU: number;
  public texV: number;

  public load(pkg: C.APackage): this {
    this.position = FVector.make().load(pkg);
    this.normal = FVector.make().load(pkg);
    this.texU = pkg.read("float");
    this.texV = pkg.read("float");

    return this;
  }
}

class FSkinVertexStream implements C.IConstructable {
  public revision: number;
  public unkVar0: number;
  public unkVar1: number;
  public vertices = new FArray(FAnimMeshVertex);

  public load(pkg: C.APackage): this {
    this.revision = pkg.read("uint32");
    this.unkVar0 = pkg.read("uint32");
    this.unkVar1 = pkg.read("uint32");
    this.vertices.load(pkg);

    return this;
  }
}

class FTriangleLOD implements C.IConstructable {
  public indices: [number, number, number] = new Array(3) as [
    number,
    number,
    number,
  ];
  public materialIndex: number;

  public load(pkg: C.APackage): this {
    this.indices[0] = pkg.read("uint16");
    this.indices[1] = pkg.read("uint16");
    this.indices[2] = pkg.read("uint16");

    this.materialIndex = pkg.read("uint16");

    return this;
  }
}
/* Bytes a HighFive LOD carries after the C4 tail fields. Measured from the exact start of the
   next LOD on two consecutive boundaries (LOD[0]->LOD[1] and LOD[1]->LOD[2] in
   Animations/Fighter.ukx, both +5), and zero-filled in every LOD inspected. */
const HIGHTFIVE_LOD_TAIL_EXTRA_BYTES = 5;

function sumSectionFaces(...lists: FSkelMeshSection[][]): number {
  let faces = 0;

  for (const list of lists) for (const section of list) faces += section.numFaces;

  return faces;
}

/* Read a compact index straight out of a byte array, allocation-free: this runs once per byte of
   the search window and the surrounding reader allocates a BufferValue per call. Mirrors
   BufferValue's `compat32` - low 6 bits of the first byte, bit 6 means "more bytes follow", bit 7
   is the sign. */
function readCompactIndexAt(bytes: Uint8Array, at: number): { value: number; length: number } {
  let b = bytes[at];
  let length = 1;
  let value = b & 0x3f;

  if (b & 0x80) return { value: -1, length: 1 }; // negative counts are never valid here

  if (b & 0x40) {
    let extra = 0;

    do {
      if (extra++ >= 4) break;
      b = bytes[at + length++];
      value |= (b & 0x7f) << (6 + 7 * (extra - 1));
    } while (b & 0x80);
  }

  return { value, length };
}

/* Locate a HighFive LOD's index buffer and vertex stream by shape.
 *
 * The C4 field order cannot be followed past the section list in a HighFive cook: it stores a
 * single index buffer, and something this port has not modelled sits between the sections and it.
 * The pair is found from the vertex stream instead, which identifies itself - every
 * `FAnimMeshVertex` is position(3f) + normal(3f) + uv(2f), and a *vertex normal is unit length*,
 * which nothing else in a LOD is.
 *
 * The index buffer is then pinned from behind by two exact checks: its element count is the span
 * the sections report, and every index must address a wedge of the stream that follows it. The two
 * revision fields in between are *not* usable - they are equal on some meshes (17/17 on a Fighter
 * face) and consecutive on others (22/23 on a Fighter hair piece).
 *
 * Returns the content-relative offset of the index count, or null. */
function locateVertexStream(
  pkg: C.APackage,
  from: number,
  expectedIndexCount: number,
  softWedgeCount: number,
): { indexCountAt: number; vertexCount: number } | null {
  if (expectedIndexCount <= 0) return null;

  const buffer = (pkg as unknown as { buffer?: ArrayBuffer }).buffer;

  if (!buffer) return null;

  const contentOffset =
    (pkg as unknown as { contentOffset?: number }).contentOffset ?? 0;
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const startAt = from + contentOffset;
  const limit = bytes.length - 32;

  for (let at = startAt; at < limit; at++) {
    const count = readCompactIndexAt(bytes, at);

    if (count.value !== expectedIndexCount) continue;

    const indexDataAt = at + count.length,
      indexEnd = indexDataAt + expectedIndexCount * 2;

    if (indexEnd + 16 > limit) return null;

    // isPartial + isStreamCallback, then the vertex count
    const vertexCount = readCompactIndexAt(bytes, indexEnd + 16);

    if (vertexCount.value < 1 || vertexCount.value > 200000) continue;

    const vertsAt = indexEnd + 16 + vertexCount.length;
    const wedgeCount = softWedgeCount + vertexCount.value;

    if (vertsAt + vertexCount.value * 32 > limit) continue;

    let unit = 0;

    for (let i = 0; i < vertexCount.value; i++) {
      const p = vertsAt + i * 32;
      const nx = view.getFloat32(p + 12, true),
        ny = view.getFloat32(p + 16, true),
        nz = view.getFloat32(p + 20, true);

      if (![nx, ny, nz].every(Number.isFinite)) break;
      if (Math.abs(Math.sqrt(nx * nx + ny * ny + nz * nz) - 1) < 0.02) unit++;
    }

    if (unit !== vertexCount.value) continue;

    let maxIndex = 0;

    for (let i = 0; i < expectedIndexCount; i++) {
      const index = view.getUint16(indexDataAt + i * 2, true);

      if (index > maxIndex) maxIndex = index;
    }

    if (maxIndex >= wedgeCount) continue;

    return { indexCountAt: at - contentOffset, vertexCount: vertexCount.value };
  }

  return null;
}

class FStaticModelLOD implements C.IConstructable {
  public skinningData = new FPrimitiveArray(BufferValue.uint32);
  public skinPoints = new FArray(FSkinPoint);
  public numSoftWedges: number;
  public softSections = new FArray(FSkelMeshSection);
  public rigidSections = new FArray(FSkelMeshSection);
  public softIndices = new FRawIndexBuffer();
  public rigidIndices = new FRawIndexBuffer();
  public skinVertexStream = new FSkinVertexStream();
  public vertexInfluences = new FArrayLazy(FVertexInfluence);
  public wedges = new FArrayLazy(FMeshWedge);
  public faces = new FArrayLazy(FTriangleLOD);
  public points = new FArrayLazy(FMeshVector);
  public lodHysteresis: number;
  public numSharedVertices: number;
  public lodMaxInfluences: number;
  public unkVar0: number;
  public unkVar1: number;

  /* The leading fields are the same in C4 and HighFive, and everything downstream of the vertex
     influences keys off them, so both layouts share these two halves. */
  protected readLeading(pkg: C.APackage): void {
    this.skinningData.load(pkg);
    this.skinPoints.load(pkg);
    this.numSoftWedges = pkg.read("int32");
    this.softSections.load(pkg);
    this.rigidSections.load(pkg);
  }

  /* `unmodelledTailBytes` is what HighFive appends after the C4 tail fields - zeros on every LOD
     measured (verified against the exact start of the next LOD on two boundaries), so they are
     stepped over rather than interpreted. */
  protected readTail(pkg: C.APackage, unmodelledTailBytes = 0): void {
    this.vertexInfluences.load(pkg);
    this.wedges.load(pkg);
    this.faces.load(pkg);
    this.points.load(pkg);

    this.lodHysteresis = pkg.read("float");
    this.numSharedVertices = pkg.read("uint32");
    this.lodMaxInfluences = pkg.read("uint32");
    this.unkVar0 = pkg.read("uint32");
    this.unkVar1 = pkg.read("uint32");
    pkg.read("uint32"); // useNewWedges - read for its size, not acted on

    if (unmodelledTailBytes > 0) pkg.read(BufferValue.allocBytes(unmodelledTailBytes));
  }

  /* Size of the LOD's single index buffer.
   *
   * A section does not index the buffer from zero: `minStreamIndex` is its offset into it, so the
   * buffer has to be at least `minStreamIndex + numStreamIndices` long. LOD levels beyond the
   * first are cooked with a non-zero offset and a shortened span (a Fighter face mesh's LOD[2] has
   * `minStreamIndex` 126 with `numStreamIndices` 126 over a 252-entry buffer), so summing
   * `3 * numFaces` under-reports and the buffer cannot be found. Fall back to the face count when
   * no section reports a span, which is what a flat single-section LOD looks like. */
  public getIndexCount(): number {
    let count = 0;

    for (const section of [...this.softSections, ...this.rigidSections])
      count = Math.max(count, section.minStreamIndex + section.numStreamIndices);

    return count || 3 * sumSectionFaces(this.softSections, this.rigidSections);
  }

  public load(pkg: C.APackage): this {
    const lodStart = pkg.tell();

    try {
      this.readLeading(pkg);
      this.softIndices.load(pkg);
      this.rigidIndices.load(pkg);
      this.skinVertexStream.load(pkg);
      this.readTail(pkg);
    } catch (e) {
      /* HighFive cooks a single index buffer and puts a structure this port does not model yet
         between the section list and it, so the C4 order above cannot be walked past
         `rigidSections`. Both are located by the vertex stream's own signature instead; see
         locateVertexStream. The tail is identical in both layouts, so only the middle differs. */
      pkg.seek(lodStart, "set");
      this.readLeading(pkg);
      this.locateStreams(pkg);
      this.readTail(pkg, HIGHTFIVE_LOD_TAIL_EXTRA_BYTES);
    }

    return this;
  }

  protected locateStreams(pkg: C.APackage): void {
    const expected = this.getIndexCount();
    const found = locateVertexStream(
      pkg,
      pkg.tell(),
      expected,
      this.numSoftWedges,
    );

    if (!found)
      throw new Error(
        `FStaticModelLOD: no index buffer / vertex stream found after ${this.softSections.length} soft and ${this.rigidSections.length} rigid section(s) (${expected} expected indices).`,
      );

    pkg.seek(found.indexCountAt, "set");
    this.rigidIndices.load(pkg);
    this.skinVertexStream.load(pkg);
  }
}

class FMeshWedge implements C.IConstructable {
  public iVertex: number;
  public texU: number;
  public texV: number;

  public load(pkg: C.APackage): this {
    this.iVertex = pkg.read("uint16");
    this.texU = pkg.read("float");
    this.texV = pkg.read("float");

    return this;
  }
}

class FTriangle implements C.IConstructable {
  public indices: [number, number, number] = new Array(3) as [
    number,
    number,
    number,
  ];
  public materialIndex: number;
  public materialIndex2: number;
  public smoothingGroups: number;

  public load(pkg: C.APackage): this {
    this.indices[0] = pkg.read("uint16");
    this.indices[1] = pkg.read("uint16");
    this.indices[2] = pkg.read("uint16");

    this.materialIndex = pkg.read("uint8");
    this.materialIndex2 = pkg.read("uint8");
    this.smoothingGroups = pkg.read("uint32");

    return this;
  }
}

class FVertexInfluence implements C.IConstructable {
  public weight: number;
  public iPoint: number;
  public iBone: number;

  public load(pkg: C.APackage): this {
    this.weight = pkg.read("float");
    this.iPoint = pkg.read("uint16");
    this.iBone = pkg.read("uint16");

    return this;
  }
}

abstract class USkeletalMesh extends ULodMesh {
  protected points2 = new FArray(FMeshVector);
  protected refSkeleton = new FArray(FMeshBone);
  protected animationId: number;
  protected animation: GA.UMeshAnimation;
  protected skeletalDepth: number;
  protected weightIndices = new FArray(FWeightIndex);
  protected boneInluences = new FArray(FBoneInfluence);
  protected attachAliases: string[];
  protected attachBoneNames: string[];
  protected attachCoords = new FArray(FMeshCoords);
  protected lodModels = new FArray(FStaticModelLOD);
  protected sk_unkIndex1: number;
  protected points = new FArrayLazy(FMeshVector);
  protected wedges = new FArrayLazy(FMeshWedge);
  protected faces = new FArrayLazy(FTriangle);
  protected vertexInfluences = new FArrayLazy(FVertexInfluence);
  protected collapseWedge = new FPrimitiveArrayLazy(BufferValue.uint16);
  protected sk_unkArr10 = new FPrimitiveArrayLazy(BufferValue.uint16);
  protected sk_unkVar1: number;
  protected sk_unkArr11 = new FPrimitiveArray(BufferValue.uint32);
  protected sk_unkVar2: number;

  public doLoad(pkg: C.APackage, exp: C.UExport) {
    const verArchive = pkg.header.getArchiveFileVersion();
    const verLicense = pkg.header.getLicenseeVersion();

    super.doLoad(pkg, exp);

    this.points2.load(pkg);
    this.refSkeleton.load(pkg);

    this.animationId = pkg.read("compat32");

    /* `fetchObject` only resolves the export; the animation's own fields (refBones, sequences,
       notifies) stay unloaded until `loadSelf`, and `getDecodeInfo` reads them. */
    if (this.animationId !== 0)
      this.animation = pkg
        .fetchObject<GA.UMeshAnimation>(this.animationId)
        .loadSelf();

    this.skeletalDepth = pkg.read("uint32");
    this.weightIndices.load(pkg);
    this.boneInluences.load(pkg);
    this.attachAliases = new FIndexArray()
      .load(pkg)
      .map((v) => pkg.nameTable[v.value].name as string);
    this.attachBoneNames = new FIndexArray()
      .load(pkg)
      .map((v) => pkg.nameTable[v.value].name as string);
    this.attachCoords.load(pkg);

    if (this.version >= 2) {
      /* Name the mesh in any LOD failure - by the time the cursor has desynced there is nothing
         left in the payload that says which object was being read. */
      try {
        this.lodModels.load(pkg);
      } catch (e) {
        throw new Error(`${this.objectName}: ${(e as Error).message}`);
      }

      /* A mesh cooked with LOD models never reaches the legacy per-mesh arrays that follow:
         `getDecodeInfo` reads geometry from `lodModels[0]` whenever the top-level wedge array is
         empty, which is every HighFive character and NPC mesh. HighFive's layout for those arrays
         is not modelled here, and walking it desyncs (the array end offsets it stores do not line
         up with any field order tried so far), so the payload is stepped over rather than
         misparsed. Only meshes without LOD models need the ported reader. */
      if (this.lodModels.length > 0) {
        pkg.seek(this.readTail, "set");
        this.readHead = this.readTail;

        return;
      }

      this.sk_unkIndex1 = pkg.read("compat32");

      if (this.sk_unkIndex1 !== 0) this.points.load(pkg);
      this.wedges.load(pkg);
      this.faces.load(pkg);
      this.vertexInfluences.load(pkg);
      this.collapseWedge.load(pkg);
      this.sk_unkArr10.load(pkg);

      if (verArchive >= 118 && verLicense >= 3)
        this.sk_unkVar1 = pkg.read("uint32");

      if (verArchive >= 123 && verLicense >= 18) {
        this.sk_unkArr11.load(pkg);
      }

      if (verArchive >= 120) {
        this.sk_unkVar2 = pkg.read("uint32");
      }

      this.readHead = pkg.tell();
    } else {
    }

    console.assert(this.readHead === this.readTail, "Should be zero");
  }

  public getDecodeInfo(
    builder: GD.DecodeLibraryBuilder,
    decodeAnimations: boolean = true,
    decodeMaterials: boolean = true,
    decodeAnimationNotifies: boolean = decodeAnimations,
  ): SkeletalMeshDecodeResult_T {
    const section = this;

    /* the vertex data lives in lodModels[0] whenever the top-level wedge array is empty -
       every C4 character and NPC mesh is cooked that way */
    const maxBoneInfluences = builder.isLoadingExtendedBoneInfluences()
      ? MAX_EXTENDED_INFLUENCES
      : MAX_BONES;
    const lod =
      section.wedges.length === 0 && section.lodModels.length > 0
        ? section.lodModels.getElem(0)
        : null;
    const skin = lod
      ? convertLodModel(
          lod,
          this.lodMeshMaterials.length,
          this.refSkeleton,
          maxBoneInfluences,
        )
      : null;
    const { positions, uvs, bones, weights, bones2, weights2, numInfs } =
      skin ??
      convertWedges(
        section.points,
        section.wedges,
        section.vertexInfluences,
        this.refSkeleton.length,
        maxBoneInfluences,
      );
    const { indices, groups } =
      skin ?? buildIndices(section.faces, this.lodMeshMaterials.length);
    const skeleton = collectSkeleton(this.refSkeleton);

    const materials = decodeMaterials
      ? this.lodMeshMaterials.map((mat: GA.UStaticMeshMaterial) =>
          builder.pullMaterial(mat),
        )
      : [];

    const materialInfo = {
      name: this.uuid,
      materialType: "group",
      materials,
    } as GD.IMaterialGroupDecodeInfo;
    const geometryInfo: GD.IGeometryDecodeInfo = {
      attributes: {
        positions,
        skinIndex: bones,
        skinWeight: weights,
        uvs,
      },
      groups,
      indices,
      bounds: this.decodeBoundsInfo(),
    };

    if (bones2) geometryInfo.attributes.skinIndex2 = bones2;
    if (weights2) geometryInfo.attributes.skinWeight2 = weights2;

    if (numInfs > maxBoneInfluences)
      console.warn(
        `Too many bone influences ${numInfs} > ${maxBoneInfluences} for ${this.objectName}`,
      );

    const animations: Record<string, GD.IKeyframeDecodeInfo_T[]> = {};
    const animationSequences: Record<string, GD.IAnimationSequenceDecodeInfo> =
      {};
    const animationNotifies: Record<string, GD.IAnimationNotifyDecodeInfo[]> =
      {};
    const skinNotifies: Record<string, GD.ISkinNotifyDecodeInfo> = {};

    const boneCount = this.refSkeleton.length;
    const boneMap = new Array(boneCount);

    if ((decodeAnimations || decodeAnimationNotifies) && this.animation) {
      const refBones = this.animation.refBones;

      if (decodeAnimations) {
        for (let i = 0; i < boneCount; i++) {
          const boneSkeleton = this.refSkeleton.getElem(i);

          for (let j = 0, len = refBones.length; j < len; j++) {
            const boneAnim = refBones.getElem(j);

            if (
              normalizeBoneName(boneSkeleton.boneName) !==
              normalizeBoneName(boneAnim.boneName)
            )
              continue;

            boneMap[i] = [normalizeBoneName(boneAnim.boneName), j];
          }
        }
      }

      for (
        let k = 0, animCount = this.animation.sequences.getElemCount();
        k < animCount;
        k++
      ) {
        const sequence = this.animation.sequences.getElem(k);
        const animName = sequence.name;

        animationSequences[animName] = {
          attackEffectFrame:
            sequence.frameCount > 0
              ? sequence.unkVar0 / sequence.frameCount
              : 0,
          attackEndEffectFrame:
            sequence.frameCount > 0
              ? sequence.unkVar1 / sequence.frameCount
              : 0,
        };

        if (decodeAnimationNotifies)
          animationNotifies[animName] = this.animation.getSequenceNotifies(
            builder,
            sequence,
          );

        skinNotifies[animName] = this.animation.getSequenceSkinNotify(sequence);

        if (!decodeAnimations) continue;

        const move = this.animation.moves[k];
        const framerate = sequence.framerate;
        const keyframes: GD.IKeyframeDecodeInfo_T[] = [];

        /* every mesh bone the animation set drives, not MotionChunk.BoneIndices -
           that array orders the tracks, it does not select them */
        for (let i = 0; i < boneCount; i++) {
          const boneMapping = boneMap[i];

          if (!boneMapping) continue; // mesh bone the animation set does not drive

          const [boneName, boneIndexAnim] = boneMapping;
          const track = move.animTracks.getElem(boneIndexAnim);
          const trackFrameCount = track.keyTime.getElemCount();

          const lenPos = track.keyPos.getElemCount();
          const lenRot = track.keyQuat.getElemCount();

          const timesPos = new Float32Array(lenPos + 1);
          const timesRot = new Float32Array(lenRot + 1);

          const positions = new Float32Array((lenPos + 1) * 3);
          const rotations = new Float32Array((lenRot + 1) * 4);

          for (let j = 0; j < trackFrameCount; j++) {
            const time = track.keyTime.getElem(j);

            if (j < lenPos) {
              const idxPos = j * 3;
              let pos = track.keyPos.getElem(j < lenPos ? j : lenPos - 1);

              pos = fixVector(pos);

              timesPos[j] = time / framerate;

              positions[idxPos + 0] = pos.x;
              positions[idxPos + 1] = pos.y;
              positions[idxPos + 2] = pos.z;
            }

            if (j < lenRot) {
              let rot = track.keyQuat.getElem(j < lenRot ? j : lenRot - 1);
              const idxRot = j * 4;

              rot = fixRotation(rot);

              if (boneIndexAnim === 0) rot = rot.conjugate();

              timesRot[j] = time / framerate;

              rotations[idxRot + 0] = rot.x;
              rotations[idxRot + 1] = rot.y;
              rotations[idxRot + 2] = rot.z;
              rotations[idxRot + 3] = rot.w;
            }
          }

          /* a sequence keys frames 0..frameCount-1 and loops back over the interval past
             the last one, which three only interpolates if the closing key is there */
          const wrapTime = sequence.frameCount / framerate;

          timesPos[lenPos] = wrapTime;
          positions.copyWithin(lenPos * 3, 0, 3);

          timesRot[lenRot] = wrapTime;
          rotations.copyWithin(lenRot * 4, 0, 4);

          keyframes.push({
            name: `${boneName}.position`,
            times: timesPos,
            values: positions,
            type: "Vector",
          });
          keyframes.push({
            name: `${boneName}.quaternion`,
            times: timesRot,
            values: rotations,
            type: "Quaternion",
          });
        }

        animations[animName] = keyframes;
      }
    }

    return {
      object: {
        uuid: this.uuid,
        type: "SkinnedMesh",
        name: this.objectName,
        geometry: this.uuid,
        materials: this.uuid,
        skeleton,
        animations,
        animationSequences,
        animationNotifies,
        skinNotifies,
        meshScale: this.meshScale.getElements(),
        meshOrigin: this.meshOrigin.getElements(),
        meshRotOrigin: this.meshRotOrigin.toArray() as GD.Vector3Arr,
        meshRotOriginQuaternion: this.meshRotOrigin.getQuaternionElements(),
        boneSimulationType: this.sk_unkVar1 || 0,
      } as GD.ISkinnedMeshObjectDecodeInfo,
      geometry: geometryInfo,
      material: materialInfo,
    };
  }
}

export default USkeletalMesh;

const MAX_BONES = 4;
const MAX_EXTENDED_INFLUENCES = 8;

function buildIndices(faces: FTriangle[], materialCount: number) {
  const countFaces = faces.length;
  const TypedIndicesArray = getTypedArrayConstructor(countFaces * 3);
  const indicesByMaterial: number[][] = new Array(materialCount);

  for (let i = 0; i < materialCount; i++) indicesByMaterial[i] = [];

  for (let i = 0; i < countFaces; i++) {
    const tri = faces[i];
    const matIndex = tri.materialIndex;
    const constainer = indicesByMaterial[matIndex];

    constainer.push(...tri.indices);
  }

  const indices = new TypedIndicesArray(indicesByMaterial.flat());
  const groups: GD.ArrGeometryGroup[] = new Array(materialCount);

  let firstIndex = 0;

  for (let i = 0; i < materialCount; i++) {
    const indexCount = indicesByMaterial[i].length;

    groups[i] = [firstIndex, indexCount, i];

    firstIndex = firstIndex + indexCount;
  }

  return { indices, groups };
}

const tmpStreamBits = new Uint32Array(1);
const tmpStreamFloat = new Float32Array(tmpStreamBits.buffer);

function readStreamFloat(
  stream: FStaticModelLOD["skinningData"],
  index: number,
) {
  tmpStreamBits[0] = stream.getElem(index);

  return tmpStreamFloat[0];
}

/* skinning stream commands, one per soft wedge: 0xF fetches a previously stored vertex,
   0x8 stores this one for a later fetch */
const SKIN_FETCH_DUPE = 0xf0000000;
const SKIN_STORE_DUPE = 0x80000000;

function getSkinningStreamMaxInfluences(lod: FStaticModelLOD) {
  const stream = lod.skinningData;
  let cursor = 0,
    numInfs = 0;

  for (let wedge = 0; wedge < lod.numSoftWedges; wedge++) {
    const command = stream.getElem(cursor) >>> 0;

    if (command >= SKIN_FETCH_DUPE) {
      cursor += 1;
    } else {
      const influenceCount = ((command >>> 28) & 0x7) + 1;

      numInfs = Math.max(numInfs, influenceCount);
      cursor += influenceCount;
    }

    cursor += 2;
  }

  return numInfs;
}

function convertSkinningStream(
  lod: FStaticModelLOD,
  positions: Float32Array,
  uvs: Float32Array,
  bones: GD.SkinIndexArray_T,
  weights: Float32Array,
  bones2: GD.SkinIndexArray_T | null,
  weights2: Float32Array | null,
  maxBoneInfluences: number,
) {
  const stream = lod.skinningData;
  const wedgeCount = lod.numSoftWedges;
  const dupes: number[] = [];
  const arrBones = new Array(MAX_EXTENDED_INFLUENCES);
  const arrWeights = new Array(MAX_EXTENDED_INFLUENCES);

  let cursor = 0,
    pointIndex = 0;

  for (let wedge = 0; wedge < wedgeCount; wedge++) {
    const command = stream.getElem(cursor) >>> 0;
    const offsetVertex = 3 * wedge,
      offsetUv = 2 * wedge,
      offsetBone = MAX_BONES * wedge;

    if (command >= SKIN_FETCH_DUPE) {
      const source = dupes[(command & 0x0fffffff) / 6];

      positions.copyWithin(offsetVertex, 3 * source, 3 * source + 3);
      bones.copyWithin(
        offsetBone,
        MAX_BONES * source,
        MAX_BONES * source + MAX_BONES,
      );
      weights.copyWithin(
        offsetBone,
        MAX_BONES * source,
        MAX_BONES * source + MAX_BONES,
      );

      if (bones2)
        bones2.copyWithin(
          offsetBone,
          MAX_BONES * source,
          MAX_BONES * source + MAX_BONES,
        );
      if (weights2)
        weights2.copyWithin(
          offsetBone,
          MAX_BONES * source,
          MAX_BONES * source + MAX_BONES,
        );

      cursor += 1;
    } else {
      const influenceCount = ((command >>> 28) & 0x7) + 1;
      const point = lod.skinPoints[pointIndex++].point;

      positions[offsetVertex + 0] = point.x;
      positions[offsetVertex + 1] = point.y;
      positions[offsetVertex + 2] = point.z;

      for (let i = 0; i < influenceCount; i++) {
        const influence = stream.getElem(cursor + i) >>> 0;

        arrBones[i] = (influence & 0xfff) / 6;
        arrWeights[i] = ((influence >>> 12) & 0xffff) / 65535;
      }

      // strongest influence first, so the four the fixed-size slots keep are the meaningful ones
      for (let i = 1; i < influenceCount; i++) {
        const bone = arrBones[i],
          weight = arrWeights[i];
        let j = i;

        while (j > 0 && weight > arrWeights[j - 1]) {
          arrBones[j] = arrBones[j - 1];
          arrWeights[j] = arrWeights[j - 1];
          j--;
        }

        arrBones[j] = bone;
        arrWeights[j] = weight;
      }

      const storedInfluenceCount = Math.min(influenceCount, maxBoneInfluences);
      let total = 0;

      for (let i = 0; i < storedInfluenceCount; i++) total += arrWeights[i];

      for (let i = 0; i < storedInfluenceCount; i++) {
        const targetIndex = offsetBone + (i % MAX_BONES);

        if (i < MAX_BONES) {
          bones[targetIndex] = arrBones[i];
          weights[targetIndex] = arrWeights[i] / total;
        } else {
          bones2![targetIndex] = arrBones[i];
          weights2![targetIndex] = arrWeights[i] / total;
        }
      }

      if (command & SKIN_STORE_DUPE) dupes.push(wedge);

      cursor += influenceCount;
    }

    uvs[offsetUv + 0] = readStreamFloat(stream, cursor);
    uvs[offsetUv + 1] = readStreamFloat(stream, cursor + 1);

    cursor += 2;
  }

  if ((stream.getElem(cursor) >>> 0) !== 0xffffffff)
    throw new Error(
      `Skinning stream stopped at ${cursor} of ${stream.getElemCount()} instead of its terminator after ${wedgeCount} wedges.`,
    );
}

/* cooked rigid sections never carry their joint index; the head parts that kept raw
   influences bind every vertex to Bip01_head */
function findRigidBone(section: FSkelMeshSection, refSkeleton: FMeshBone[]) {
  if (section.boneIndex !== 0) return section.boneIndex;

  for (let i = 0, len = refSkeleton.length; i < len; i++) {
    if (/^bip01[ _]head$/i.test(refSkeleton[i].boneName)) return i;
  }

  return 0;
}

function convertLodModel(
  lod: FStaticModelLOD,
  materialCount: number,
  refSkeleton: FMeshBone[],
  maxBoneInfluences: number,
) {
  const rigidStream = lod.skinVertexStream.vertices;
  const softCount = lod.numSoftWedges,
    rigidCount = rigidStream.length;
  const vertexCount = softCount + rigidCount;
  const numInfs = softCount > 0 ? getSkinningStreamMaxInfluences(lod) : 0;
  const useExtendedBoneInfluences =
    maxBoneInfluences > MAX_BONES && numInfs > MAX_BONES;

  const positions = new Float32Array(3 * vertexCount);
  const uvs = new Float32Array(2 * vertexCount);
  const BoneIndexConstructor = getTypedArrayConstructor(refSkeleton.length);
  const bones = new BoneIndexConstructor(MAX_BONES * vertexCount);
  const weights = new Float32Array(MAX_BONES * vertexCount);
  const bones2 = useExtendedBoneInfluences
    ? new BoneIndexConstructor(MAX_BONES * vertexCount)
    : null;
  const weights2 = useExtendedBoneInfluences
    ? new Float32Array(MAX_BONES * vertexCount)
    : null;

  if (softCount > 0)
    convertSkinningStream(
      lod,
      positions,
      uvs,
      bones,
      weights,
      bones2,
      weights2,
      maxBoneInfluences,
    );

  for (let i = 0; i < rigidCount; i++) {
    const vertex = rigidStream.getElem(i);
    const offsetVertex = 3 * (softCount + i),
      offsetUv = 2 * (softCount + i);

    positions[offsetVertex + 0] = vertex.position.x;
    positions[offsetVertex + 1] = vertex.position.y;
    positions[offsetVertex + 2] = vertex.position.z;

    uvs[offsetUv + 0] = vertex.texU;
    uvs[offsetUv + 1] = vertex.texV;
  }

  const softBuffer = lod.softIndices.indices,
    rigidBuffer = lod.rigidIndices.indices;
  const softIndexCount = softBuffer.getElemCount(),
    rigidIndexCount = rigidBuffer.getElemCount();
  const IndexConstructor = getTypedArrayConstructor(vertexCount);
  const indices = new IndexConstructor(softIndexCount + rigidIndexCount);

  for (let i = 0; i < softIndexCount; i++) indices[i] = softBuffer.getElem(i);

  for (let i = 0; i < rigidIndexCount; i++)
    indices[softIndexCount + i] = softCount + rigidBuffer.getElem(i);

  const groups: GD.ArrGeometryGroup[] = [];

  for (let i = 0, len = lod.softSections.length; i < len; i++) {
    const section = lod.softSections[i];

    groups.push([
      3 * section.firstFace,
      3 * section.numFaces,
      Math.min(section.materialIndex, materialCount - 1),
    ]);
  }

  /* rigid sections reuse the influence-count slot to name the single bone every vertex
     in the section binds to */
  for (let i = 0, len = lod.rigidSections.length; i < len; i++) {
    const section = lod.rigidSections[i];
    const boneIndex = findRigidBone(section, refSkeleton);

    for (
      let vertex = section.minWedgeIndex;
      vertex <= section.maxWedgeIndex && vertex < rigidCount;
      vertex++
    ) {
      bones[MAX_BONES * (softCount + vertex)] = boneIndex;
      weights[MAX_BONES * (softCount + vertex)] = 1;
    }

    groups.push([
      softIndexCount + 3 * section.firstFace,
      3 * section.numFaces,
      Math.min(section.materialIndex, materialCount - 1),
    ]);
  }

  return { positions, uvs, bones, weights, bones2, weights2, indices, groups, numInfs };
}

function convertWedges(
  points: FVector[],
  wedges: FMeshWedge[],
  influences: FVertexInfluence[],
  boneCount: number,
  maxBoneInfluences: number,
) {
  const vertexInfos: VertexInfo_T[] = new Array(points.length);

  for (let i = 0, len = points.length; i < len; i++) {
    vertexInfos[i] = {
      numInfs: 0,
      bones: new Array(MAX_EXTENDED_INFLUENCES).fill(0),
      weights: new Array(MAX_EXTENDED_INFLUENCES).fill(0),
    };
  }

  let numInfs = 0;

  // collect influences per vertex
  for (const infl of influences) {
    const vinfo = vertexInfos[infl.iPoint];

    const idx = vinfo.numInfs++;

    numInfs = Math.max(numInfs, vinfo.numInfs);

    // add the influence
    vinfo.bones[idx] = infl.iBone;
    vinfo.weights[idx] = infl.weight;
  }

  // strongest influence first, then normalize over what the vertex can store
  for (const V of vertexInfos) {
    if (!V || V.numInfs === 0) continue;

    for (let i = 1; i < V.numInfs; i++) {
      const bone = V.bones[i],
        weight = V.weights[i];
      let j = i;

      while (j > 0 && weight > V.weights[j - 1]) {
        V.bones[j] = V.bones[j - 1];
        V.weights[j] = V.weights[j - 1];
        j--;
      }

      V.bones[j] = bone;
      V.weights[j] = weight;
    }

    const influenceCount = Math.min(V.numInfs, maxBoneInfluences);
    let s = 0;

    for (let j = 0; j < influenceCount; j++)
      // count sum
      s += V.weights[j];

    s = 1.0 / s;

    for (let j = 0; j < influenceCount; j++)
      // adjust weights
      V.weights[j] *= s;
  }

  const wedgeCount = wedges.length;
  const positions = new Float32Array(3 * wedgeCount);
  const uvs = new Float32Array(2 * wedgeCount);
  const BoneIndexConstructor = getTypedArrayConstructor(boneCount);
  const bones = new BoneIndexConstructor(MAX_BONES * wedgeCount);
  const weights = new Float32Array(MAX_BONES * wedgeCount);
  const useExtendedBoneInfluences =
    maxBoneInfluences > MAX_BONES && numInfs > MAX_BONES;
  const bones2 = useExtendedBoneInfluences
    ? new BoneIndexConstructor(MAX_BONES * wedgeCount)
    : null;
  const weights2 = useExtendedBoneInfluences
    ? new Float32Array(MAX_BONES * wedgeCount)
    : null;

  // create vertices
  for (let i = 0; i < wedgeCount; i++) {
    const wedge = wedges[i];
    const vinfo = vertexInfos[wedge.iVertex];

    const point = points[wedge.iVertex].getElements();
    const texU = wedge.texU,
      texV = wedge.texV;

    const offsetUv = 2 * i,
      offsetVertex = 3 * i,
      offsetBone = MAX_BONES * i;

    positions[offsetVertex + 0] = point[0];
    positions[offsetVertex + 1] = point[1];
    positions[offsetVertex + 2] = point[2];

    uvs[offsetUv + 0] = texU;
    uvs[offsetUv + 1] = texV;

    for (
      let j = 0, len = Math.min(vinfo.numInfs, maxBoneInfluences);
      j < len;
      j++
    ) {
      const off = offsetBone + (j % MAX_BONES);

      if (j < MAX_BONES) {
        bones[off] = vinfo.bones[j];
        weights[off] = vinfo.weights[j];
      } else {
        bones2![off] = vinfo.bones[j];
        weights2![off] = vinfo.weights[j];
      }
    }
  }

  return { positions, uvs, bones, weights, bones2, weights2, numInfs };
}

/* bodyparts of one character disagree on the casing of shared bones, so one part's clip
   only binds to the others once names are canonical */
function normalizeBoneName(name: string) {
  return name.replaceAll(" ", "_").toLowerCase();
}

function collectSkeleton(refSkeleton: FMeshBone[]): GD.IBoneDecodeInfo[] {
  const boneCount = refSkeleton.length;
  const boneInfos = new Array<GD.IBoneDecodeInfo>(boneCount);
  const boneCoords = new Array<FBoneCoord>(boneCount);
  // const matrices = [];

  for (let boneIndex = 0; boneIndex < boneCount; boneIndex++) {
    const bone = refSkeleton[boneIndex];

    let bonePos = bone.bonePos.position.clone();
    let boneRot = bone.bonePos.rotation.clone();

    if (boneIndex === 0) boneRot = boneRot.conjugate();

    bonePos = fixVector(bonePos);
    boneRot = fixRotation(boneRot);

    boneInfos[boneIndex] = {
      type: "Bone",
      uuid: generateUUID(),
      name: normalizeBoneName(bone.boneName),
      parent: bone.parentIndex,
      position: [bonePos.x, bonePos.y, bonePos.z],
      quaternion: [boneRot.x, boneRot.y, boneRot.z, boneRot.w],
    } as GD.IBoneDecodeInfo;

    boneRot.w = -boneRot.w;

    let bc = (boneCoords[boneIndex] = new FBoneCoord());
    bc.origin = bonePos;
    bc.axis = boneRot.toAxis();

    if (boneIndex > 0) {
      bc = boneCoords[boneIndex] =
        boneCoords[bone.parentIndex].untransformCoords(bc);
    }

    // const invCoords = bc.invert();

    // matrices.push(invCoords.toElements());
  }

  return boneInfos;
}

type VertexInfo_T = {
  numInfs: number;
  bones: number[];
  weights: number[];
};

class FBoneCoord {
  // `FVector` is a UObject - only the package-built class has a layout, so use its `make` factory.
  public origin: FVector = FVector.make();
  public axis: FAxis = new FAxis();

  public invert() {
    const out = new FBoneCoord();

    // negate inverse rotated origin
    out.origin = this.axis.transformVector(this.origin).negate();

    // transpose axis
    out.axis.x.x = this.axis.x.x;
    out.axis.x.y = this.axis.y.x;
    out.axis.x.z = this.axis.z.x;
    out.axis.y.x = this.axis.x.y;
    out.axis.y.y = this.axis.y.y;
    out.axis.y.z = this.axis.z.y;
    out.axis.z.x = this.axis.x.z;
    out.axis.z.y = this.axis.y.z;
    out.axis.z.z = this.axis.z.z;

    return out;
  }

  public untransformPoint(src: FVector) {
    let tmp = this.origin;

    tmp = this.axis.x.multiplyScalar(src.x).add(tmp);
    tmp = this.axis.y.multiplyScalar(src.y).add(tmp);
    tmp = this.axis.z.multiplyScalar(src.z).add(tmp);

    return tmp;
  }

  public untransformCoords(src: FBoneCoord) {
    const out = new FBoneCoord();

    out.origin = this.untransformPoint(src.origin);
    out.axis = this.axis.untransformAxis(src.axis);

    return out;
  }

  toElements() {
    return [
      this.axis.x.x,
      this.axis.x.y,
      this.axis.x.z,
      0,
      this.axis.y.x,
      this.axis.y.y,
      this.axis.y.z,
      0,
      this.axis.z.x,
      this.axis.z.y,
      this.axis.z.z,
      0,
      this.origin.x,
      this.origin.y,
      this.origin.z,
      1,
    ];
  }
}

/* These two are UObjects, so they cannot be built with `new` - only the class the package builds
   has a layout, and that is what the injected `make` factory returns. */
function fixVector(v: FVector) {
  return FVector.make(v.x, v.z, v.y);
}
function fixRotation(v: FQuaternion) {
  return FQuaternion.make(v.x, v.z, v.y, v.w);
}
