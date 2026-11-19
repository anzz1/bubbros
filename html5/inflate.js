// A zlib decompressor for the HTML5 client of Bub's Brothers.
//
// The game server sends zlib data in three ways:
//
//  * complete streams (files, images);
//  * one long stream cut in pieces, each piece ending with a "sync
//    flush", so that a piece can be decompressed as soon as it is
//    received (the frames sent over the WebSocket);
//  * the same, but the stream starts in a known state instead of an
//    empty one (the frames sent over the WebRTC data channel, see
//    dynamicDecompress() in bubbros.js).
//
// An Inflater handles all three: feed() takes one piece and returns
// what it decompresses to, and the last 32 kilobytes of output are kept
// as the history for the next piece.

(function (global) {
'use strict';

var WINDOW = 32768;

var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
                   35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
                    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
                 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
                 8193, 12289, 16385, 24577];
var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
                  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
var CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2,
                  14, 1, 15];

// A canonical Huffman code, from the bit length of each symbol.
function Huffman(lengths, start, n) {
    var count = this.count = new Uint16Array(16);
    var symbol = this.symbol = new Uint16Array(n);
    var offset = new Uint16Array(16);
    var i;
    for (i = 0; i < n; i++)
        count[lengths[start + i]]++;
    count[0] = 0;
    for (i = 1; i < 16; i++)
        offset[i] = offset[i - 1] + count[i - 1];
    for (i = 0; i < n; i++)
        if (lengths[start + i])
            symbol[offset[lengths[start + i]]++] = i;
}

var FIXED_LITERALS, FIXED_DISTANCES;
(function () {
    var lengths = new Uint8Array(288 + 30);
    var i;
    for (i = 0; i < 144; i++) lengths[i] = 8;
    for (; i < 256; i++) lengths[i] = 9;
    for (; i < 280; i++) lengths[i] = 7;
    for (; i < 288; i++) lengths[i] = 8;
    for (; i < 318; i++) lengths[i] = 5;
    FIXED_LITERALS = new Huffman(lengths, 0, 288);
    FIXED_DISTANCES = new Huffman(lengths, 288, 30);
})();


function Inflater(header) {
    // header: is there a zlib header at the start of the stream?
    this.header = (header === undefined) ? true : header;
    this.history = new Uint8Array(0);
    this.finished = false;
}

// Start with 'data' as the history, as if it had just been decompressed.
Inflater.prototype.prime = function (data) {
    this.history = data.length > WINDOW ?
        data.slice(data.length - WINDOW) : data.slice();
};

// Decompress one piece.  Throws an Error if the data is invalid, cut in
// the middle of a block, or gives more than 'limit' bytes.
Inflater.prototype.feed = function (input, limit) {
    var inpos = 0, inlen = input.length;
    var bitbuf = 0, bitcnt = 0;
    var base = this.history.length;
    var out = new Uint8Array(base + Math.max(1024, inlen * 4));
    var outpos = base;
    out.set(this.history);
    limit = base + (limit || 0x1000000);

    function bits(n) {
        while (bitcnt < n) {
            if (inpos >= inlen)
                throw new Error('inflate: truncated data');
            bitbuf |= input[inpos++] << bitcnt;
            bitcnt += 8;
        }
        var value = bitbuf & ((1 << n) - 1);
        bitbuf >>>= n;
        bitcnt -= n;
        return value;
    }

    function decode(h) {
        var code = 0, first = 0, index = 0, count;
        for (var len = 1; len < 16; len++) {
            code |= bits(1);
            count = h.count[len];
            if (code - count < first)
                return h.symbol[index + (code - first)];
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        throw new Error('inflate: bad code');
    }

    function room(n) {
        if (outpos + n > limit)
            throw new Error('inflate: too much data');
        if (outpos + n > out.length) {
            var bigger = new Uint8Array(Math.max(out.length * 2, outpos + n));
            bigger.set(out.subarray(0, outpos));
            out = bigger;
        }
    }

    function stored() {
        bitbuf = 0;
        bitcnt = 0;
        if (inpos + 4 > inlen)
            throw new Error('inflate: truncated data');
        var len = input[inpos] | (input[inpos + 1] << 8);
        var nlen = input[inpos + 2] | (input[inpos + 3] << 8);
        inpos += 4;
        if (len !== (~nlen & 0xFFFF))
            throw new Error('inflate: bad stored block');
        if (inpos + len > inlen)
            throw new Error('inflate: truncated data');
        room(len);
        out.set(input.subarray(inpos, inpos + len), outpos);
        inpos += len;
        outpos += len;
    }

    function dynamic() {
        var nlen = bits(5) + 257;
        var ndist = bits(5) + 1;
        var ncode = bits(4) + 4;
        if (nlen > 286 || ndist > 30)
            throw new Error('inflate: bad counts');
        var lengths = new Uint8Array(320);
        var i, sym, len, repeat;
        for (i = 0; i < ncode; i++)
            lengths[CODE_ORDER[i]] = bits(3);
        var lencode = new Huffman(lengths, 0, 19);
        lengths = new Uint8Array(320);
        i = 0;
        while (i < nlen + ndist) {
            sym = decode(lencode);
            if (sym < 16) {
                lengths[i++] = sym;
            } else {
                len = 0;
                if (sym === 16) {
                    if (i === 0)
                        throw new Error('inflate: bad lengths');
                    len = lengths[i - 1];
                    repeat = 3 + bits(2);
                } else if (sym === 17) {
                    repeat = 3 + bits(3);
                } else {
                    repeat = 11 + bits(7);
                }
                if (i + repeat > nlen + ndist)
                    throw new Error('inflate: bad lengths');
                while (repeat--)
                    lengths[i++] = len;
            }
        }
        codes(new Huffman(lengths, 0, nlen), new Huffman(lengths, nlen, ndist));
    }

    function codes(literals, distances) {
        var sym, len, dist, from;
        for (;;) {
            sym = decode(literals);
            if (sym < 256) {
                room(1);
                out[outpos++] = sym;
            } else if (sym === 256) {
                return;
            } else {
                sym -= 257;
                if (sym >= 29)
                    throw new Error('inflate: bad length code');
                len = LENGTH_BASE[sym] + bits(LENGTH_EXTRA[sym]);
                sym = decode(distances);
                if (sym >= 30)
                    throw new Error('inflate: bad distance code');
                dist = DIST_BASE[sym] + bits(DIST_EXTRA[sym]);
                if (dist > outpos)
                    throw new Error('inflate: distance too far back');
                room(len);
                from = outpos - dist;
                while (len--)
                    out[outpos++] = out[from++];
            }
        }
    }

    if (this.header && inlen > 0) {
        if (inlen < 2 || (input[0] & 0x0F) !== 8 ||
            ((input[0] << 8) | input[1]) % 31 !== 0 || (input[1] & 0x20))
            throw new Error('inflate: bad zlib header');
        inpos = 2;
        this.header = false;
    }
    // A piece ends on a byte boundary, after the empty stored block of
    // a sync flush; a complete stream ends with its last block (the
    // checksum that follows is not verified).
    while (!this.finished && (inpos < inlen || bitcnt > 0)) {
        var last = bits(1);
        var type = bits(2);
        if (type === 0)
            stored();
        else if (type === 1)
            codes(FIXED_LITERALS, FIXED_DISTANCES);
        else if (type === 2)
            dynamic();
        else
            throw new Error('inflate: bad block type');
        if (last)
            this.finished = true;
    }

    this.history = out.slice(Math.max(0, outpos - WINDOW), outpos);
    return out.slice(base, outpos);
};

// Decompress a complete zlib stream.
function inflate(data, limit) {
    return new Inflater().feed(data, limit);
}

global.Inflater = Inflater;
global.inflate = inflate;

})(typeof window !== 'undefined' ? window : globalThis);
