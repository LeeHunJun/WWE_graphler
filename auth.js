// 로그인·회원가입 화면. 로그인하지 않으면 앱 대신 이 화면을 보여준다.
const $ = (selector) => document.querySelector(selector);

async function request(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`/api/auth/${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw new Error("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
  if (!response.ok) {
    const error = new Error(payload.error || "요청을 처리하지 못했어요.");
    error.code = payload.code;
    throw error;
  }
  return payload;
}

export async function fetchCurrentUser() {
  const { user } = await request("me");
  return user || null;
}

export async function signOut() {
  try {
    await request("logout", { method: "POST", body: {} });
  } finally {
    window.location.reload();
  }
}

export async function updateProfile(changes) {
  const { user } = await request("me", { method: "PATCH", body: changes });
  return user;
}

function setAppHidden(hidden) {
  const shell = $(".app-shell");
  shell.hidden = hidden;
  shell.inert = hidden;
}

function setMode(mode) {
  const isSignup = mode === "signup";
  $("#login-form").hidden = isSignup;
  $("#signup-form").hidden = !isSignup;
  document.querySelectorAll("[data-auth-mode]").forEach((tab) => {
    const selected = tab.dataset.authMode === mode;
    tab.classList.toggle("is-selected", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  const form = isSignup ? $("#signup-form") : $("#login-form");
  form.querySelector("input")?.focus();
}

function setError(form, message) {
  const error = form.querySelector(".form-error");
  error.textContent = message || "";
  error.hidden = !message;
}

// 로그인한 사용자를 돌려준다. 로그인 전이면 로그인/회원가입 화면을 띄우고 끝날 때까지 기다린다.
export async function ensureSignedIn() {
  const screen = $("#auth-screen");
  const status = $("#auth-status");
  let user = null;
  try {
    user = await fetchCurrentUser();
  } catch (error) {
    status.textContent = error.message;
    status.hidden = false;
  }
  if (user) {
    screen.hidden = true;
    setAppHidden(false);
    return user;
  }

  setAppHidden(true);
  screen.hidden = false;
  setMode(window.location.hash === "#signup" ? "signup" : "login");

  return new Promise((resolve) => {
    const completeSignIn = (signedIn) => {
      screen.hidden = true;
      setAppHidden(false);
      if (window.location.hash === "#signup") window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      resolve(signedIn);
    };

    document.querySelectorAll("[data-auth-mode]").forEach((tab) => {
      tab.addEventListener("click", () => setMode(tab.dataset.authMode));
    });

    const handle = (form, path, collect) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setError(form, "");
        status.hidden = true;
        const submit = form.querySelector("[type=submit]");
        submit.disabled = true;
        try {
          const body = collect(form);
          const { user: signedIn } = await request(path, { method: "POST", body });
          completeSignIn(signedIn);
        } catch (error) {
          setError(form, error.message);
          if (error.code === "USERNAME_TAKEN") {
            $("#login-form").elements.username.value = form.elements.username.value;
          }
        } finally {
          submit.disabled = false;
        }
      });
    };

    const guestButton = $("#guest-login");
    guestButton.addEventListener("click", async () => {
      status.hidden = true;
      guestButton.disabled = true;
      try {
        const { user: guest } = await request("guest", { method: "POST", body: {} });
        completeSignIn(guest);
      } catch (error) {
        status.textContent = error.message;
        status.hidden = false;
      } finally {
        guestButton.disabled = false;
      }
    });

    handle($("#login-form"), "login", (form) => ({
      username: form.elements.username.value,
      password: form.elements.password.value,
    }));
    handle($("#signup-form"), "signup", (form) => {
      if (form.elements.password.value !== form.elements.passwordConfirm.value) {
        throw new Error("비밀번호 확인이 서로 달라요.");
      }
      return {
        name: form.elements.name.value,
        username: form.elements.username.value,
        password: form.elements.password.value,
      };
    });
  });
}
