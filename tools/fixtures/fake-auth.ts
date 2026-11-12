export function fakeAuth(account: string, generation = 0) {
  const claims = { email: `${account}@example.invalid`, exp: Math.floor(Date.now()/1000)+86400, generation,
    "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_user_id: account, chatgpt_plan_type: "plus" } };
  const token = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fake`;
  return { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: token, access_token: token, refresh_token: `fake-refresh-${account}-${generation}`, account_id: account }, last_refresh: new Date().toISOString() };
}
