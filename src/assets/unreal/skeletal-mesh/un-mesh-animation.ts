import { BufferValue } from "@l2js/core";
import FArray, { FPrimitiveArray } from "@l2js/core/unreal/un-array";
import UObject from "@l2js/core";
import FQuaternion from "../un-quaternion";
import FVector from "../un-vector";
import { FIndexArray } from "@l2js/core/unreal/un-array";

class FNamedBone implements C.IConstructable {
  public boneName: string;
  public flags: number;
  public parentIndex: number;

  public load(pkg: C.APackage): this {
    this.boneName = pkg.nameTable[pkg.read("compat32")].name as string;
    this.flags = pkg.read("uint32");
    this.parentIndex = pkg.read("uint32");

    return this;
  }
}

class FAnalogTrack implements C.IConstructable {
  public flags: number;
  public keyQuat = new FArray(FQuaternion);
  public keyPos = new FArray(FVector);
  public keyTime = new FPrimitiveArray(BufferValue.float);

  public load(pkg: C.APackage): this {
    this.flags = pkg.read("uint32");
    this.keyQuat.load(pkg);
    this.keyPos.load(pkg);
    this.keyTime.load(pkg);

    return this;
  }
}

class FMotionChunk implements C.IConstructable {
  public rootSpeed3d: FVector;
  public trackTime: number;
  public startBone: number;
  public flags: number;
  public boneIndices = new FPrimitiveArray(BufferValue.uint32);
  public animTracks = new FArray(FAnalogTrack);
  public rootTrack = new FAnalogTrack();

  public load(pkg: C.APackage): this {
    this.rootSpeed3d = FVector.make().load(pkg);
    this.trackTime = pkg.read("float");
    this.startBone = pkg.read("uint32");
    this.flags = pkg.read("uint32");
    this.boneIndices.load(pkg);
    this.animTracks.load(pkg);
    this.rootTrack.load(pkg);

    return this;
  }
}

class FMeshAnimNotify implements C.IConstructable {
  public time: number;
  public name: string;
  public notifyObjectId: number;

  public load(pkg: C.APackage): this {
    const verArchive = pkg.header.getArchiveFileVersion();

    this.time = pkg.read("float");
    this.name = pkg.nameTable[pkg.read("compat32")].name as string;

    if (verArchive >= 112) {
      this.notifyObjectId = pkg.read("compat32");
    }

    if (verArchive >= 131) {
    }

    return this;
  }
}

/* skin-notify timelines address body-part materials by index: the material named `<x>_f`
   carries variant 0, `<x>_f1` … variant 1 and so on. */
class FSkinNotifyEntry implements C.IConstructable {
  public time: number;
  public skinIndex: number;

  public load(pkg: C.APackage): this {
    this.time = pkg.read("float");
    this.skinIndex = pkg.read("int32");

    return this;
  }
}

class FSkinNotifyGroup implements C.IConstructable {
  public startFrame: number;
  public timeline = new FArray(FSkinNotifyEntry);

  public load(pkg: C.APackage): this {
    this.startFrame = pkg.read("float");
    this.timeline.load(pkg);

    return this;
  }
}

/* licensee ≥ 0x1a trailer of FAnimSequence; the pre-0x1b layout is the fixed timeline
   alone, the 0x1b one prepends the mode and appends the grouped/random variants */
class FSkinNotify implements C.IConstructable {
  public fixedTimeline = new FArray(FSkinNotifyEntry);
  public mode: SkinNotifyMode_T;
  public groupedTimeline = new FArray(FSkinNotifyGroup);
  public randomIntervalMin: number;
  public randomIntervalMax: number;
  public randomTimeline = new FArray(FSkinNotifyEntry);

  public load(pkg: C.APackage): this {
    const verLicense = pkg.header.getLicenseeVersion();

    if (verLicense === 0x1a) {
      this.fixedTimeline.load(pkg);
    } else if (verLicense >= 0x1b) {
      this.mode = pkg.read("uint8");
      this.fixedTimeline.load(pkg);
      this.groupedTimeline.load(pkg);
      this.randomIntervalMin = pkg.read("float");
      this.randomIntervalMax = pkg.read("float");
      this.randomTimeline.load(pkg);
    }

    return this;
  }
}

class FAnimSequence implements C.IConstructable {
  public bookmark: number;
  public unkVar0: number;
  public name: string;
  public groupNames: string[];
  public frameStart: number;
  public frameCount: number;
  public notifications = new FArray(FMeshAnimNotify);
  public framerate: number;
  public unkVar1: number;
  public unkIndex0: number;
  public unkVar2: number;
  public unkVar4: number;
  public unkVar5: number;
  public skinNotify = new FSkinNotify();

  public load(pkg: C.APackage): this {
    const verArchive = pkg.header.getArchiveFileVersion();
    const verLicense = pkg.header.getLicenseeVersion();

    if (verArchive >= 115) this.bookmark = pkg.read("float");
    else {
    }

    this.name = pkg.nameTable[pkg.read("compat32")].name as string;
    this.groupNames = new FIndexArray()
      .load(pkg)
      .map((v) => pkg.nameTable[v.value].name as string);

    this.frameStart = pkg.read("uint32");
    this.frameCount = pkg.read("uint32");
    this.notifications.load(pkg);
    this.framerate = pkg.read("float");

    if (verLicense >= 1) {
      this.unkVar0 = pkg.read("uint32");
      this.unkVar1 = pkg.read("uint32");

      if (verLicense >= 2) this.unkVar2 = pkg.read("uint32");

      this.unkIndex0 = pkg.read("compat32");

      if (verLicense >= 0x14) this.unkVar4 = pkg.read("uint32");
      if (verLicense >= 0x19) this.unkVar5 = pkg.read("uint32");
      if (verLicense >= 0x1a) this.skinNotify.load(pkg);
    }

    return this;
  }
}

enum SkinNotifyMode_T {
  Fixed,
  Grouped,
  Random,
}

function decodeNotifyObject(
  builder: GD.DecodeLibraryBuilder,
  notify: UObject,
): GD.IAnimationNotifyObjectDecodeInfo {
  if (!notify) return null;

  const info = (notify as GA.UAnimNotify).getDecodeInfo(builder);

  if (info === undefined)
    throw new Error(
      `Animation notify '${notify.objectName}' returned undefined decode info.`,
    );

  return info;
}

abstract class UMeshAnimation extends UObject {
  public version: number;
  public refBones: FArray<FNamedBone>;
  public moves: FMotionChunk[];
  public sequences: FArray<FAnimSequence>;

  public getSequenceNotifies(
    builder: GD.DecodeLibraryBuilder,
    sequence: FAnimSequence,
  ): GD.IAnimationNotifyDecodeInfo[] {
    const count = sequence.notifications.getElemCount();
    const notifications = new Array<GD.IAnimationNotifyDecodeInfo>(count);

    for (let i = 0; i < count; i++) {
      const notify = sequence.notifications.getElem(i);
      let notifyObject: UObject = null;

      if (notify.notifyObjectId !== 0) {
        try {
          notifyObject = this.pkg.fetchObject(notify.notifyObjectId).loadSelf();
        } catch (e) {
          /* A single unresolvable notify object (unimplemented AnimNotify subclass, or a
             cooked import HighFive's script packages don't carry) used to take out the whole
             character/mesh decode. Same "prefer null over failing everything" treatment as
             UPackage.fetchObject already gives unresolved imports - drop this one notify's
             object and keep going. */
          console.warn(
            `[anim] '${sequence.name}' notify '${notify.name}' object could not be resolved: ${(e as Error).message}`,
          );
        }
      }

      notifications[i] = {
        time: notify.time,
        name: notify.name,
        object: decodeNotifyObject(builder, notifyObject),
      };
    }

    notifications.sort((a, b) => a.time - b.time);

    return notifications;
  }

  public getSequenceSkinNotify(
    sequence: FAnimSequence,
  ): GD.ISkinNotifyDecodeInfo {
    const info = sequence.skinNotify;
    const frameCount = sequence.frameCount;

    switch (info.mode ?? SkinNotifyMode_T.Fixed) {
      case SkinNotifyMode_T.Fixed:
        return {
          mode: "fixed",
          frameCount,
          timeline: info.fixedTimeline.map((entry) => ({
            time: entry.time,
            skinIndex: entry.skinIndex,
          })),
        };
      case SkinNotifyMode_T.Grouped:
        return {
          mode: "grouped",
          frameCount,
          groups: info.groupedTimeline.map((group) => ({
            startFrame: group.startFrame,
            timeline: group.timeline.map((entry) => ({
              time: entry.time,
              skinIndex: entry.skinIndex,
            })),
          })),
        };
      case SkinNotifyMode_T.Random:
        return {
          mode: "random",
          frameCount,
          intervalMin: info.randomIntervalMin,
          intervalMax: info.randomIntervalMax,
          timeline: info.randomTimeline.map((entry) => ({
            time: entry.time,
            skinIndex: entry.skinIndex,
          })),
        };
      default:
        throw new Error(
          `Unknown skin notify mode '${info.mode}' in animation '${sequence.name}'.`,
        );
    }
  }

  public doLoad(pkg: C.APackage, exp: C.UExport) {
    const verArchive = pkg.header.getArchiveFileVersion();
    const verLicense = pkg.header.getLicenseeVersion();

    super.doLoad(pkg, exp);

    this.version = pkg.read("uint32");
    this.refBones = new FArray(FNamedBone).load(pkg); // maybe sounds for each of the animation

    if (verArchive >= 123 && verLicense >= 25) {
      const endPos = pkg.read("uint32");
      const countMotion = pkg.read("compat32");

      this.moves = new Array<FMotionChunk>(countMotion);

      this.readHead = pkg.tell();

      for (let i = 0; i < countMotion; i++) {
        const endPos = pkg.read("uint32");

        const chunk = new FMotionChunk().load(pkg);
        this.readHead = pkg.tell();

        this.moves[i] = chunk;

        console.assert(this.readHead == endPos);

        //
      }

      console.assert(this.readHead == endPos);

      this.sequences = new FArray(FAnimSequence).load(pkg);
    } else {
    }

    this.readHead = pkg.tell();

    console.assert(this.readHead === this.readTail, "Should be zero");
  }
}

export default UMeshAnimation;
export { SkinNotifyMode_T, FAnimSequence, FSkinNotify, FNamedBone };
