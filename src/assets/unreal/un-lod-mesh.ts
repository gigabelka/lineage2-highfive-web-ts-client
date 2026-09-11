import { BufferValue } from "@l2js/core";
import FArray, {
  FObjectArray,
  FPrimitiveArray,
} from "@l2js/core/unreal/un-array";
import FColor from "./un-color";
import UMesh from "./un-mesh";
import FRotator from "./un-rotator";
import FVector from "./un-vector";

class FUnknownStruct1 implements C.IConstructable {
  public a: number;
  public b: number;
  public c: number;
  public d: number;

  public load(pkg: GA.UPackage): this {
    this.a = pkg.read("uint16");
    this.b = pkg.read("uint16");
    this.c = pkg.read("uint16");
    this.d = pkg.read("uint16");

    return this;
  }
}

class FUnknownStruct2 implements C.IConstructable {
  public unkInt16: number;
  public unkInt32_0: number;
  public unkInt32_1: number;

  public load(pkg: C.APackage): this {
    this.unkInt16 = pkg.read("uint16");
    this.unkInt32_0 = pkg.read("uint32");
    this.unkInt32_1 = pkg.read("uint32");

    return this;
  }
}

class FUnknownStruct3 implements C.IConstructable {
  public unkInt32_0: number;
  public unkInt32_1: number;

  public load(pkg: C.APackage): this {
    this.unkInt32_0 = pkg.read("uint32");
    this.unkInt32_1 = pkg.read("uint32");

    return this;
  }
}

abstract class ULodMesh extends UMesh {
  protected version: number;
  protected vertexCount: number;
  protected unkArr0 = new FPrimitiveArray(BufferValue.uint32);

  /* mesh-local placement of the vertices, read straight by USkeletalMesh.getDecodeInfo */
  protected meshScale: FVector;
  protected meshOrigin: FVector;
  protected meshRotOrigin: FRotator;
  protected unkArr2 = new FPrimitiveArray(BufferValue.uint16);
  protected unkArr3 = new FArray(FUnknownStruct1);
  protected unkArr4 = new FPrimitiveArray(BufferValue.uint16);
  protected unkArr5: FArray<FUnknownStruct2> = new FArray(FUnknownStruct2);
  protected unkArr6: FArray<FUnknownStruct3> = new FArray(FUnknownStruct3);
  protected meshScaleMax: number;
  protected lodHysteresis: number;
  protected lodStrength: number;
  protected lodMinVerts: number;
  protected lodMorph: number;
  protected lodZDisplace: number;
  protected hasImpostor: boolean;
  protected skinTesselationFactor: number;
  protected unkVar2: number;
  protected impostor = new MeshImpostor();
  protected lodMeshMaterials = new FObjectArray<GA.UMaterial>();

  public doLoad(pkg: C.APackage, exp: C.UExport) {
    super.doLoad(pkg, exp);

    this.version = pkg.read("uint32");
    this.vertexCount = pkg.read("uint32");

    this.unkArr0.load(pkg);

    if (this.version < 2) {
    }

    this.lodMeshMaterials.load(pkg);

    this.meshScale = FVector.make(
      pkg.read("float"),
      pkg.read("float"),
      pkg.read("float"),
    );
    this.meshOrigin = FVector.make(
      pkg.read("float"),
      pkg.read("float"),
      pkg.read("float"),
    );
    this.meshRotOrigin = FRotator.make(
      pkg.read("int32"),
      pkg.read("int32"),
      pkg.read("int32"),
    );

    if (this.version < 2) {
    }

    this.unkArr2.load(pkg);
    this.unkArr3.load(pkg);
    this.unkArr4.load(pkg);
    this.unkArr5.load(pkg);
    this.unkArr6.load(pkg);

    this.meshScaleMax = pkg.read("float");
    this.lodHysteresis = pkg.read("float");
    this.lodStrength = pkg.read("float");
    this.lodMinVerts = pkg.read("int32");
    this.lodMorph = pkg.read("float");
    this.lodZDisplace = pkg.read("float");

    if (this.version >= 3) {
      const maybeHasImpostor = pkg.read("uint32");

      if (maybeHasImpostor !== 0 && maybeHasImpostor !== 1) {
      }

      this.hasImpostor = maybeHasImpostor !== 0;
      this.impostor.load(pkg);
    }

    if (this.version >= 4) {
      this.skinTesselationFactor = pkg.read("uint32");
    }

    if (this.version >= 5) {
      this.unkVar2 = pkg.read("uint32");
    }
  }
}

export default ULodMesh;

class MeshImpostor implements C.IConstructable {
  public location: FVector;
  public rotation: FRotator;
  public scale: FVector;
  public color: FColor;
  public spaceMode: number;
  public drawMode: number;
  public lightMode: number;
  public materialId: number;
  public material: GA.UMaterial;

  public load(pkg: C.APackage): this {
    this.materialId = pkg.read("compat32");

    this.location = FVector.make().load(pkg);
    this.rotation = FRotator.make().load(pkg);
    this.scale = FVector.make().load(pkg);
    this.color = FColor.make().load(pkg);
    this.spaceMode = pkg.read("uint32");
    this.drawMode = pkg.read("uint32");
    this.lightMode = pkg.read("uint32");

    this.material = pkg.fetchObject<GA.UMaterial>(this.materialId);

    return this;
  }
}
