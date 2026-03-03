async function test(client, text) {
    const tl = 'zh-CN';
    const url = `https://translate.googleapis.com/translate_a/single?client=${client}&sl=en&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
    try {
        console.log(`Running test for ${client}...`);
        const response = await fetch(url);
        if (!response.ok) {
            console.log(`Client: ${client} -> Error status ${response.status}`);
            return;
        }
        const data = await response.json();
        const result = data[0].map(part => part[0]).join("");
        console.log(`Client: ${client} -> ${result}`);
    } catch (e) {
        console.log(`Client: ${client} failed: ${e.message}`);
    }
}

const text = "A Black Baldy is prodded into a small auditorium. It’s going to go as a packer animal.";
console.log(`Original: ${text}\n`);

async function run() {
    await test('gtx', text);
    await test('t', text);
    await test('webapp', text);
    await test('dict-chrome-ex', text);
}

run();
