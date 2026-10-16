import {
  UserManager,
  WebStorageStateStore,
  InMemoryWebStorage,
} from "oidc-client-ts";
export type IdentityConfig = {
  issuer: string;
  clientId: string;
  audience: string;
  redirectUri: string;
};
let manager: UserManager | undefined;
let callback: Promise<string> | undefined;
export function oidc(c: IdentityConfig) {
  return (manager ??= new UserManager({
    authority: c.issuer,
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: "code",
    scope: "openid documents:read analysis:write",
    resource: c.audience,
    automaticSilentRenew: false,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: sessionStorage }),
  }));
}
export function finishSignIn(c: IdentityConfig) {
  return (callback ??= oidc(c)
    .signinRedirectCallback()
    .then((u) => {
      history.replaceState({}, "", location.pathname);
      return u.access_token;
    }));
}
