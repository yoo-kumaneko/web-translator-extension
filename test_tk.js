function sM(a) {
    var b;
    if (null !== bM) b = bM;
    else {
        b = bM = "";
        var c = bM = "440364.32485544"; // This is a recent TKK, needs to be updated but let's try
    }
    var d = b.split(".");
    b = Number(d[0]) || 0;
    for (var e = [], f = 0, g = 0; g < a.length; g++) {
        var h = a.charCodeAt(g);
        128 > h ? e[f++] = h : (2048 > h ? e[f++] = h >> 6 | 192 : (55296 == (h & 64512) && g + 1 < a.length && 56320 == (a.charCodeAt(g + 1) & 64512) ? (h = 65536 + ((h & 1023) << 10) + (a.charCodeAt(++g) & 1023), e[f++] = h >> 18 | 240, e[f++] = h >> 12 & 63 | 128) : e[f++] = h >> 12 | 224, e[f++] = h >> 6 & 63 | 128), e[f++] = h & 63 | 128)
    }
    a = b;
    for (f = 0; f < e.length; f++) a += e[f], a = tM(a, "+-a^+6");
    a = tM(a, "+-3^+b+-f");
    a ^= Number(d[1]) || 0;
    0 > a && (a = (a & 2147483647) + 2147483648);
    a %= 1E6;
    return a.toString() + "." + (a ^ b)
}

function tM(a, b) {
    for (var c = 0; c < b.length - 2; c += 3) {
        var d = b.charAt(c + 2);
        d = "a" <= d ? d.charCodeAt(0) - 87 : Number(d);
        d = "+" == b.charAt(c + 1) ? a >>> d : a << d;
        a = "+" == b.charAt(c) ? a + d & 4294967295 : a ^ d
    }
    return a
}

var bM = null;

async function run() {
    const text = "A Black Baldy is prodded into a small auditorium.";
    const tk = sM(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=webapp&sl=en&tl=zh-CN&dt=t&tk=${tk}&q=${encodeURIComponent(text)}`;
    console.log(`TK: ${tk}`);
    console.log(`URL: ${url}`);
    
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Referer': 'https://translate.google.com/'
            }
        });
        if (!response.ok) {
            console.log(`Error: ${response.status}`);
            const body = await response.text();
            console.log(body);
            return;
        }
        const data = await response.json();
        console.log(`Result: ${data[0][0][0]}`);
    } catch (e) {
        console.log(`Failed: ${e.message}`);
    }
}

run();
