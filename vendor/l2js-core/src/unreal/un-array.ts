import BufferValue from "../buffer-value";
import UExport from "./un-export";
import FArrayPrimitive from "./un-array-primitive";

/*
 * UObject subclasses cannot be built with `new` - only the class a package dynamically builds
 * (via UStruct.buildClass) has a working layout, and that class is what the `make` factory
 * injected by `onClassCreated` returns. Plain IConstructable helpers (FWeightIndex etc.) have no
 * `make` and are constructed normally. Prefer `make` when the element type provides one, so
 * arrays of native structs (FVector/FColor/FQuaternion...) decode instead of throwing
 * "Layout for 'X' must be overloaded by the package".
 */
function createElement(Constructor: { new (...pars: any): any }): any {
  const make = (Constructor as any)?.make;

  return typeof make === "function" ? make() : new Constructor();
}

class FArray<
  T extends
    | C.UObject
    | FArrayPrimitive<C.NumberTypes_T | C.StringTypes_T>
    | IConstructable,
>
  extends Array<T>
  implements IConstructable
{
  declare ["constructor"]: typeof FArray;

  protected Constructor: { new (...pars: any): T };

  public getElemCount() {
    return this.length;
  }
  public getElem(idx: number): T {
    return this[idx];
  }
  public getConstructor() {
    return this.Constructor;
  }

  public constructor(constr: { new (...pars: any): T }, len = 0) {
    super(len);

    this.Constructor = constr;
  }

  public map<T2>(fnMap: (value: T, index: number, array: T[]) => T2): T2[] {
    return [...this].map(fnMap);
  }

  public load(
    pkg: C.APackage,
    tag?: C.PropertyTag,
    opts?: { nativeElements?: boolean },
  ): this {
    const hasTag = tag !== null && tag !== undefined;
    const nativeElements = opts?.nativeElements === true;
    const beginIndex = hasTag ? pkg.tell() : null;
    const countAt = pkg.tell();
    const count = pkg.read("compat32");

    /* Setting a negative count throws V8's `RangeError: Invalid array length`, which names
       neither the array nor the offset - the only evidence a whole decode is desynced is lost.
       Fail with where it happened instead; a wrong count here always means an earlier field was
       read with the wrong shape. */
    if (count < 0 || count > 0xffffffff)
      throw new RangeError(
        `FArray<${this.Constructor?.name ?? "?"}>: implausible element count ${count} at offset ${countAt} of '${pkg.path}' - the read cursor has desynced.`,
      );

    this.length = count;

    if (count === 0) return this;

    // Tagged struct/class array elements are serialized as self-delimiting
    // tagged property lists (each terminated by a "None" tag) and are NOT a
    // fixed size — e.g. L2FogInfo.Colors holds L2EnvironmentColorInfo records of
    // 50/50/.../42 bytes. The old `dataSize / count` heuristic floored the
    // per-element size and made `readNamedProps` stop one byte before the "None"
    // terminator, desyncing every subsequent element and tripping the assert
    // below. Bound each element by the whole remaining payload instead and let
    // its "None" terminator delimit it. `nativeElements` covers arrays whose
    // element struct (Vector/Rotator/Color) is serialized raw, with no tags.
    const payloadEnd = hasTag ? beginIndex + tag.dataSize : null;

    for (let i = 0, len = this.length; i < len; i++) {
      if (!hasTag || nativeElements) {
        this[i] = createElement(this.Constructor).load(pkg);
        continue;
      }

      const exp = new UExport();

      exp.size = payloadEnd - pkg.tell();
      exp.objectName = `${tag.name}[${i + 1}/${count}]`;
      exp.offset = pkg.tell();

      this[i] = createElement(this.Constructor).load(pkg, exp);
    }

    if (hasTag) console.assert(pkg.tell() - beginIndex - tag.dataSize === 0);

    return this;
  }

  public copy(other: FArray<T>): this {
    if (!other) return this;

    this.Constructor = other.Constructor;

    for (const v of other) this.push(v);

    return this;
  }

  public nativeClone(): FArray<T> {
    return new this.constructor(this.Constructor).copy(this);
  }
  public toString() {
    return `ArrayLazy<${this.Constructor?.name ?? undefined}>(len=${this.getElemCount()}, ...)`;
  }
}

class FArrayLazy<
  T extends
    | C.UObject
    | FArrayPrimitive<C.NumberTypes_T | C.StringTypes_T>
    | IConstructable,
> extends FArray<T> {
  public unkLazyInt: number;

  public load(pkg: C.APackage, tag?: C.PropertyTag): this {
    this.unkLazyInt = pkg.read("int32") as number;

    super.load(pkg, tag);

    /* `unkLazyInt` is the end of the array, and `tell()` is content-relative, so the two must
       agree exactly. This is the cheapest desync detector in the whole reader: when it fires, the
       array that follows it is being read from the wrong offset. It used to be silenced with
       `dontThrow` on the theory that HighFive used different semantics - it does not, that was a
       cursor that had already desynced earlier. The count is included so the report says which
       array and how much of it was consumed. */
    console.assert(
      pkg.tell() - this.unkLazyInt === 0,
      `${this.constructor.name}<${this.Constructor?.name ?? "?"}>: end=${pkg.tell()} unkLazyInt=${
        this.unkLazyInt
      } count=${this.length}`,
    );

    return this;
  }

  public copy(other: FArrayLazy<T>): this {
    if (!other) return this;

    this.unkLazyInt = other.unkLazyInt;

    return this;
  }

  public toString() {
    return `ArrayLazy<${this.Constructor?.name ?? undefined}>(len=${this.getElemCount()}, ...)`;
  }
}

class FIndexArray extends FArray<FArrayPrimitive<"compat32">> {
  public constructor(len = 0) {
    super(FArrayPrimitive.forType(BufferValue.compat32), len);
  }

  public static loadOfSize(pkg: C.APackage, size: number): FIndexArray {
    const indexArray = new FIndexArray();
    const Constructor = FArrayPrimitive.forType(BufferValue.compat32);

    for (let i = 0; i < size; i++) indexArray.push(new Constructor().load(pkg));

    return indexArray;
  }

  public toString() {
    return `IndexArray(len=${this.getElemCount()}, ...)`;
  }
}

class FStringArray extends FArray<FArrayPrimitive<"char">> {
  public constructor(len = 0) {
    super(FArrayPrimitive.forType(BufferValue.char), len);
  }

  public toString() {
    return `StringArray(len=${this.getElemCount()}, ...)`;
  }
}

class FObjectArray<T extends C.UObject = C.UObject>
  extends Array<T>
  implements IConstructable
{
  protected indexArray = new FIndexArray();

  public static loadOfIndex<T extends C.UObject = C.UObject>(
    indexArray: FIndexArray,
    pkg: C.APackage,
    tag?: C.PropertyTag,
  ): FObjectArray<T> {
    const objectArray = new FObjectArray<T>();
    objectArray.indexArray = indexArray;

    let i = 0;
    for (const index of indexArray)
      objectArray[i++] = pkg.fetchObject<T>(index.value);

    return objectArray;
  }

  public static loadOfSize<T extends C.UObject = C.UObject>(
    size: number,
    pkg: C.APackage,
    tag?: C.PropertyTag,
  ): FObjectArray<T> {
    const objectArray = new FObjectArray<T>();
    objectArray.indexArray = FIndexArray.loadOfSize(pkg, size);

    let i = 0;
    for (const index of objectArray.indexArray)
      objectArray[i++] = pkg.fetchObject<T>(index.value);

    return objectArray;
  }

  public load(pkg: C.APackage, tag?: C.PropertyTag): this {
    this.indexArray.load(pkg, tag);

    let i = 0;

    for (const index of this.indexArray)
      this[i++] = pkg.fetchObject<T>(index.value);

    return this;
  }

  public getIndexList(): number[] {
    return this.indexArray.map((v) => v.value);
  }

  public loadSelf(): this {
    for (const obj of this) obj.loadSelf();

    return this;
  }

  public copy(other: FObjectArray<T>): this {
    if (!other) return this;

    this.indexArray = other.indexArray;

    for (const v of other) this.push(v);

    return this;
  }

  public nativeClone(): FObjectArray<T> {
    return new FObjectArray<T>().copy(this);
  }
  public getElemCount() {
    return this.length;
  }
  public toString() {
    return `ObjectArray(len=${this.getElemCount()}, ...)`;
  }
}

class FNameArray extends Array<string> implements IConstructable {
  protected indexArray = new FIndexArray();

  public load(pkg: C.APackage, tag?: C.PropertyTag): this {
    this.indexArray.load(pkg, tag);

    let i = 0;

    for (const index of this.indexArray)
      this[i++] = pkg.nameTable[index.value].name;

    return this;
  }

  public loadSelf(): this {
    return this;
  }

  public copy(other: FNameArray): this {
    if (!other) return this;

    this.indexArray = other.indexArray;

    for (const v of other) this.push(v);

    return this;
  }

  public nativeClone(): FNameArray {
    return new FNameArray().copy(this);
  }
  public getElemCount() {
    return this.length;
  }

  public toString() {
    return `NameArray(len=${this.getElemCount()}, ...)`;
  }
}

class FPrimitiveArray<
  T extends C.AllPrimitiveNumberTypes_T,
> implements IConstructable {
  declare ["constructor"]: typeof FPrimitiveArray;

  protected array = new DataView(new ArrayBuffer(0));
  protected Constructor: C.ValidTypes_T<T>;

  public toString() {
    return `PrimitiveArray<${this.Constructor?.name ?? undefined}>(len=${this.getElemCount()}, ...)`;
  }

  public getElemCount() {
    return this.array ? this.array.byteLength / this.Constructor.bytes : 0;
  }
  public getElem(idx: number): number {
    let funName: string = null;

    switch (this.Constructor.name) {
      case "int64":
        funName = "getBigInt64";
        break;
      case "uint64":
        funName = "getBigUint64";
        break;
      case "int32":
        funName = "getInt32";
        break;
      case "float":
        funName = "getFloat32";
        break;
      case "uint32":
        funName = "getUint32";
        break;
      case "int8":
        funName = "getInt8";
        break;
      case "uint8":
        funName = "getUint8";
        break;
      case "int16":
        funName = "getInt16";
        break;
      case "uint16":
        funName = "getUint16";
        break;
      default:
        throw new Error(`Unknown type: ${this.Constructor.name}`);
    }

    return (this.array as any)[funName](idx * this.Constructor.bytes, true);
  }

  public constructor(constr: C.ValidTypes_T<T>) {
    this.Constructor = constr;
  }

  public *iter(): Generator<number, null, unknown> {
    for (let i = 0, len = this.getElemCount(); i < len; i++)
      yield this.getElem(i);

    return null;
  }

  public map<T>(fnMap: (value: any, index: number, array: any[]) => T): T[] {
    return [...(this as any as Array<T>)].map(fnMap);
  }

  public load(pkg: C.APackage, tag?: C.PropertyTag): this {
    const hasTag = tag !== null && tag !== undefined;
    const beginIndex = hasTag ? pkg.tell() : null;
    const elementCount = pkg.read("compat32") as number;

    if (elementCount === 0) {
      this.array = new DataView(new ArrayBuffer(0));
      return this;
    }

    const byteLength = elementCount * this.Constructor.bytes;

    this.array = pkg.readPrimitive(pkg.tell(), byteLength);

    pkg.seek(byteLength);

    if (hasTag) console.assert(pkg.tell() - beginIndex - tag.dataSize === 0);

    return this;
  }

  public getArrayBufferSlice() {
    // throw new Error("not implemented")
    // return this.array.buffer.slice(0, 0);
    return this.array.buffer.slice(
      this.array.byteOffset,
      this.array.byteOffset + this.getByteLength(),
    );
  }

  public getTypedArray(): ReturnType<T> {
    try {
      return new (this.Constructor.dtype as any)(
        this.array.buffer,
        this.array.byteOffset,
        this.getElemCount(),
      ) as any;
    } catch (e) {
      if (e.message.includes("should be a multiple of"))
        return new this.Constructor.dtype(this.getArrayBufferSlice()) as any;

      throw e;
    }
  }

  public getByteLength() {
    return this.array.byteLength;
  }

  // Populate the array from an already-positioned DataView instead of reading a
  // count + payload off the stream. Used for layouts where the element data sits
  // at a location the normal (count-prefixed) serialization can't reach — e.g. the
  // C4 0x100 texture layout, where the single mip payload is recovered off the
  // export tail (see UTexture.doLoad).
  public setBackingView(view: DataView): this {
    this.array = view;
    return this;
  }

  public nativeClone() {
    return new this.constructor(this.Constructor).copy(this);
  }
  public copy(other: FPrimitiveArray<T>): this {
    if (!other) return this;

    this.array = new DataView(
      other.array.buffer,
      other.array.byteOffset,
      other.array.byteLength,
    );

    return this;
  }
}

type ReturnType<T extends C.PrimitiveNumberTypes_T | C.BigNumberTypes_T> =
  T extends "uint8"
    ? Uint8Array
    : T extends "int8"
      ? Int8Array
      : T extends "uint16"
        ? Uint16Array
        : T extends "int16"
          ? Int16Array
          : T extends "uint32"
            ? Uint32Array
            : T extends "int32"
              ? Int32Array
              : T extends "uint64"
                ? BigUint64Array
                : T extends "int64"
                  ? BigInt64Array
                  : never;

class FPrimitiveArrayLazy<
  T extends C.PrimitiveNumberTypes_T | C.BigNumberTypes_T,
> extends FPrimitiveArray<T> {
  public unkLazyInt: number;

  public load(pkg: C.APackage, tag?: C.PropertyTag): this {
    this.unkLazyInt = pkg.read("int32") as number;

    super.load(pkg, tag);

    /* `unkLazyInt` is the end of the array, and `tell()` is content-relative, so the two must
       agree exactly. This is the cheapest desync detector in the whole reader: when it fires, the
       array that follows it is being read from the wrong offset. It used to be silenced with
       `dontThrow` on the theory that HighFive used different semantics - it does not, that was a
       cursor that had already desynced earlier. The count is included so the report says which
       array and how much of it was consumed. */
    console.assert(
      pkg.tell() - this.unkLazyInt === 0,
      `${this.constructor.name}<${this.Constructor?.name ?? "?"}>: end=${pkg.tell()} unkLazyInt=${
        this.unkLazyInt
      } count=${this.length}`,
    );

    return this;
  }

  public copy(other: FPrimitiveArrayLazy<T>): this {
    if (!other) return this;

    super.copy(other);
    this.unkLazyInt = other.unkLazyInt;

    return this;
  }

  public toString() {
    return `PrimitiveArrayLazy<${this.Constructor?.name ?? undefined}>(len=${this.getElemCount()}, ...)`;
  }
}

export default FArray;
export {
  FArray,
  FArrayLazy,
  FIndexArray,
  FStringArray,
  FNameArray,
  FPrimitiveArray,
  FObjectArray,
  FPrimitiveArrayLazy,
};
