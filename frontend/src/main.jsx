import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App.jsx";
import "./shared/styles/app.css";
import "./library/library.css";
import "./settings/settings.css";

// iPadOS defaults to "Request Desktop Website", where Safari reports
// (hover: hover) and (pointer: fine) exactly like a Mac — so no media query
// can spot a touch device there. maxTouchPoints stays truthful in that mode,
// so hover-gated UI keys off this attribute as well as the media query.
if (navigator.maxTouchPoints > 0) document.documentElement.dataset.touch = "1";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
