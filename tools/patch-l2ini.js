#!/usr/bin/env node
/*
 * patch-l2ini.js — сменить ServerAddr в оригинальном l2.ini клиента C4.
 *
 * l2.ini зашифрован схемой Lineage2Ver413 (RSA-блоки l2encdec + zlib). Скрипт
 * расшифровывает файл, правит строку `ServerAddr=` в секции [URL] и сохраняет
 * результат либо ПЛАЙНТЕКСТОМ (по умолчанию — клиенты C4 читают незашифрованный
 * l2.ini), либо заново зашифрованным Lineage2Ver413 (флаг --encrypt).
 *
 * Usage:
 *   node tools/patch-l2ini.js --ip 192.168.0.33              # -> плайнтекст
 *   node tools/patch-l2ini.js --ip 192.168.0.33 --encrypt    # -> Lineage2Ver413
 *   node tools/patch-l2ini.js --check                         # только показать [URL]
 *   node tools/patch-l2ini.js --ip X --file path/to/l2.ini
 *
 * Зависимостей нет — только встроенные zlib/fs + BigInt.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/* l2encdec public key (Lineage2Ver411/413 decode).
 * Дублирует node_modules/@l2js/core/src/crypto/keys/rsa.ts (rsaKeys.encdec). */
const RSA_MODULUS_HEX =
    "75b4d6de5c016544068a1acf125869f43d2e09fc55b8b1e289556daf9b8757635" +
    "593446288b3653da1ce91c87bb1a5c18f16323495c55d7d72c0890a83f69bfd1f" +
    "d9434eb1c02f3e4679edfa43309319070129c267c85604d87bb65bae205de3707" +
    "af1d2108881abb567c3b3d069ae67c3a4c6a3aa93d26413d4c66094ae2039";
const RSA_EXPONENT = 0x1dn; // decode-экспонента (ей же дешифрует игровой клиент)

/* encode-экспонента того же ключа l2encdec.
 * Источник: acmi/L2crypt -> src/main/java/.../crypt/rsa/L2Ver41x.java
 *           константа PUBLIC_EXPONENT_L2ENCDEC.
 * Корректность проверяется round-trip'ом перед записью (см. encryptVer413). */
const RSA_ENC_EXPONENT_HEX =
    "30b4c2d798d47086145c75063c8e841e719776e400291d7838d3e6c4405b504c6" +
    "a07f8fca27f32b86643d2649d1d5f124cdd0bf272f0909dd7352fe10a77b34d83" +
    "1043d9ae541f8263c6fe3d1c14c2f04e43a7253a6dda9a8c1562cbd493c1b631a" +
    "1957618ad5dfe5ca28553f746e2fc6f2db816c7db223ec91e955081c1de65";
const RSA_ENC_EXPONENT = BigInt("0x" + RSA_ENC_EXPONENT_HEX);

const BLOCK_SIZE = 128;
const HEADER_SIZE = 28; // "Lineage2Ver413" в UTF-16LE

// --- CLI -------------------------------------------------------------------

function parseArgs(argv) {
    const args = { ip: null, file: null, check: false, encrypt: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--check") args.check = true;
        else if (a === "--encrypt" || a === "--reencrypt") args.encrypt = true;
        else if (a === "--ip") args.ip = argv[++i];
        else if (a === "--file") args.file = argv[++i];
        else if (a === "-h" || a === "--help") { args.help = true; }
        else throw new Error(`Неизвестный аргумент: ${a}`);
    }
    return args;
}

const IP_RE = /^(\d{1,3})(\.\d{1,3}){3}$/;

// --- crypto --------------------------------------------------------------

function modPow(base, exp, mod) {
    base %= mod;
    if (base < 0n) base += mod;
    let result = 1n;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        base = (base * base) % mod;
        exp >>= 1n;
    }
    return result;
}

function bytesToBigInt(buf) {
    let x = 0n;
    for (const b of buf) x = (x << 8n) | BigInt(b);
    return x;
}

function bigIntToBlock(x) {
    let hex = x.toString(16);
    if (hex.length < BLOCK_SIZE * 2) hex = "0".repeat(BLOCK_SIZE * 2 - hex.length) + hex;
    hex = hex.slice(-BLOCK_SIZE * 2);
    return Buffer.from(hex, "hex");
}

/*
 * Порт RSADecoder из @l2js/core (crypto/decryption/decrypt-rsa.ts) на BigInt.
 * Возвращает Buffer с распакованным (inflate) содержимым.
 */
function decryptVer41x(body) {
    const mod = BigInt("0x" + RSA_MODULUS_HEX);
    const chunks = [];
    let readOffset = 0;

    while (readOffset + BLOCK_SIZE < body.length) {
        const cipher = body.subarray(readOffset, readOffset + BLOCK_SIZE);
        const plain = bigIntToBlock(modPow(bytesToBigInt(cipher), RSA_EXPONENT, mod));

        const size = plain[3] & 0xff;
        if (size < 0 || size > BLOCK_SIZE - 4)
            throw new Error(`Битый блок (size=${size}) — не тот ключ/версия?`);

        const start = BLOCK_SIZE - size - (((BLOCK_SIZE - 4) - size) % 4);
        chunks.push(Buffer.from(plain.subarray(start, start + size)));
        readOffset += start + size; // именно start+size, не BLOCK_SIZE
    }

    const cat = Buffer.concat(chunks);
    if (cat.length < 4) throw new Error("Расшифрованный поток слишком короткий");

    const archiveSize = cat.readUInt32LE(0);
    const inflated = zlib.inflateSync(cat.subarray(4));
    if (inflated.length !== archiveSize)
        throw new Error(`Размер не сошёлся: ожидалось ${archiveSize}, получено ${inflated.length}`);

    return inflated;
}

/*
 * Зеркало decryptVer41x: собирает Lineage2Ver413-файл из плайнтекста.
 *   payload = [uint32 LE archiveSize][ zlib.deflate(plain) ]
 *   payload режется на куски <= 124 байта, каждый кладётся в 128-байтный блок
 *   по тому же смещению `start`, что читает декодер, и шифруется c = m^e_enc mod N.
 *   К телу дописывается 20 нулевых байт (как в оригинальном файле).
 */
function encryptVer413(plainBuf) {
    const mod = BigInt("0x" + RSA_MODULUS_HEX);
    const MAX = BLOCK_SIZE - 4; // 124

    const head = Buffer.alloc(4);
    head.writeUInt32LE(plainBuf.length, 0);
    const payload = Buffer.concat([head, zlib.deflateSync(plainBuf)]);

    const out = [];
    for (let off = 0; off < payload.length; off += MAX) {
        const chunk = payload.subarray(off, off + MAX);
        const size = chunk.length;
        const start = BLOCK_SIZE - size - ((MAX - size) % 4);

        const block = Buffer.alloc(BLOCK_SIZE);
        block[3] = size;
        chunk.copy(block, start);

        out.push(bigIntToBlock(modPow(bytesToBigInt(block), RSA_ENC_EXPONENT, mod)));
    }
    out.push(Buffer.alloc(20)); // padding: декодеру нужно bodyLen > numBlocks*128

    const header = Buffer.from("Lineage2Ver413", "utf16le"); // 28 байт
    return Buffer.concat([header, ...out]);
}

// --- l2.ini -------------------------------------------------------------

function isEncrypted(buf) {
    // "L\0i\0" — начало "Lineage2Ver..." в UTF-16LE
    return buf.length >= 4 && buf[0] === 0x4c && buf[1] === 0x00 && buf[2] === 0x69 && buf[3] === 0x00;
}

function getPlaintext(buf) {
    if (!isEncrypted(buf)) return { text: buf.toString("latin1"), wasEncrypted: false };
    const version = buf.subarray(HEADER_SIZE - 6, HEADER_SIZE).toString("utf16le");
    if (!version.startsWith("41"))
        throw new Error(`Поддерживается только Lineage2Ver41x, найдено: ${version}`);
    const inflated = decryptVer41x(buf.subarray(HEADER_SIZE));
    return { text: inflated.toString("latin1"), wasEncrypted: true, version };
}

function extractSection(text, name) {
    const start = text.indexOf(`[${name}]`);
    if (start === -1) return null;
    const after = text.indexOf("\n[", start + 1);
    return text.slice(start, after === -1 ? undefined : after).replace(/\s+$/, "");
}

function patchServerAddr(text, ip) {
    const re = /^([ \t]*ServerAddr[ \t]*=[ \t]*)(.*)$/im;
    const m = text.match(re);
    if (!m) throw new Error("Строка `ServerAddr=` в l2.ini не найдена");
    const old = m[2].trim();
    if (old === ip) return { text, old, changed: false };
    return { text: text.replace(re, `$1${ip}`), old, changed: true };
}

// --- main --------------------------------------------------------------

function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        console.log("node tools/patch-l2ini.js --ip <addr> [--encrypt] [--file <l2.ini>] [--check]");
        return;
    }

    const file = path.resolve(args.file || "c:/Games/HighFive/system/l2.ini");
    if (!fs.existsSync(file)) throw new Error(`Файл не найден: ${file}`);

    const raw = fs.readFileSync(file);
    const { text, wasEncrypted, version } = getPlaintext(raw);

    console.log(`Файл:      ${file}`);
    console.log(`Формат:    ${wasEncrypted ? `зашифрован (Lineage2Ver${version})` : "плайнтекст"}`);

    const urlSection = extractSection(text, "URL");
    if (args.check) {
        console.log("\n--- [URL] ---");
        console.log(urlSection || "(секция [URL] не найдена)");
        return;
    }

    if (!args.ip) throw new Error("Укажите --ip <addr> (или --check для просмотра)");
    if (!IP_RE.test(args.ip)) throw new Error(`Некорректный IP: ${args.ip}`);

    const { text: patched, old, changed } = patchServerAddr(text, args.ip);
    const needFormatChange = args.encrypt ? !wasEncrypted : wasEncrypted;
    if (!changed && !needFormatChange) {
        console.log(`\nServerAddr уже = ${args.ip}, формат совпадает — изменений нет.`);
        return;
    }
    if (!changed)
        console.log(`\nServerAddr уже = ${args.ip}; меняю только формат файла.`);

    const bak = file + ".bak";
    if (!fs.existsSync(bak)) {
        fs.writeFileSync(bak, raw);
        console.log(`Бэкап:     ${bak}`);
    } else {
        console.log(`Бэкап:     ${bak} (уже существует, не трогаю)`);
    }

    const patchedBuf = Buffer.from(patched, "latin1");
    let outBuf;

    if (args.encrypt) {
        outBuf = encryptVer413(patchedBuf);
        // Обязательная самопроверка: расшифровать обратно и сверить с исходным текстом.
        const back = getPlaintext(outBuf);
        if (!back.wasEncrypted || back.text !== patched)
            throw new Error("Round-trip не сошёлся — RSA_ENC_EXPONENT неверна, файл НЕ записан");
        console.log("Round-trip decrypt(encrypt(P)) == P: OK");
    } else {
        // Плайнтекст: пишем байты как есть (latin1 round-trip сохраняет кодировку).
        outBuf = patchedBuf;
    }

    fs.writeFileSync(file, outBuf);
    console.log(`\nServerAddr: ${old} -> ${args.ip}`);
    console.log(args.encrypt
        ? `l2.ini сохранён зашифрованным (Lineage2Ver413, ${outBuf.length} байт).`
        : "l2.ini сохранён плайнтекстом.");
}

try {
    main();
} catch (err) {
    console.error(`Ошибка: ${err.message}`);
    process.exit(1);
}
