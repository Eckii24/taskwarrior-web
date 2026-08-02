function request(app) {
    const makeRequest = (method, initialPath) => {
        let path = initialPath;
        let body;
        const headers = new Headers();
        const chain = {
            set(name, value) { headers.set(name, value); return chain; },
            send(value) {
                body = typeof value === 'string' ? value : JSON.stringify(value);
                if (!headers.has('Content-Type') && typeof value !== 'string') headers.set('Content-Type', 'application/json');
                return chain;
            },
            query(values) {
                const query = new URLSearchParams(values);
                path += `${path.includes('?') ? '&' : '?'}${query}`;
                return chain;
            },
            then(resolve, reject) {
                return app.fetch(new Request(`http://localhost${path}`, { method, headers, body }))
                    .then(async (response) => ({
                        status: response.status,
                        headers: Object.fromEntries(response.headers),
                        text: await response.text(),
                        response,
                    }))
                    .then(async (result) => {
                        try { result.body = result.text ? JSON.parse(result.text) : {}; } catch { result.body = {}; }
                        return result;
                    })
                    .then(resolve, reject);
            },
        };
        return chain;
    };
    return Object.fromEntries(['get', 'post', 'put', 'delete', 'options'].map((method) => [method, (path) => makeRequest(method.toUpperCase(), path)]));
}
module.exports = { request };
