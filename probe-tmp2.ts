async function main() {
  await import("@unreal/un-package");              // full unreal graph + mixin
  const FVector: any = (await import("@unreal/un-vector")).default;
  try { const v = new FVector(1, 2, 3); console.log("new FVector OK:", JSON.stringify(v)); }
  catch (e) { console.log("new FVector THREW:", (e as Error).message); }
  try { const v = FVector.make(1, 2, 3); console.log("FVector.make OK:", JSON.stringify(v)); }
  catch (e) { console.log("FVector.make THREW:", (e as Error).message); }
  const UObject: any = (await import("@l2js/core")).UObject;
  console.log("makeLayout still base:", UObject.prototype.makeLayout.toString().includes("must be overloaded"));
}
main().catch(e => { console.error("FAIL", e); process.exit(1); });
