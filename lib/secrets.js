const {SecretManagerServiceClient} = require('@google-cloud/secret-manager');

const fetchSecrets = async (local) => {
    const secrets = {};

    if (local) {
        secrets.client_id = process.env.GITHUB_CLIENT_ID_DEV;
        secrets.client_secret = process.env.GITHUB_CLIENT_SECRET_DEV;
    }
    else{
        secrets.client_id = process.env.GITHUB_CLIENT_ID;
        secrets.client_secret = process.env.GITHUB_CLIENT_SECRET;
    }

    const client = new SecretManagerServiceClient();
    let fetchedSecrets = {};

    for (const [key, value] of Object.entries(secrets)) {
        const [version] = await client.accessSecretVersion({ name: value });
        fetchedSecrets[key] = version.payload.data.toString();
    }

    return fetchedSecrets;
};

module.exports = {
    fetchSecrets
};
