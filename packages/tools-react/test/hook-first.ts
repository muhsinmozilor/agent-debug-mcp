// Import this FIRST in a test file so the DevTools hook exists before react-dom evaluates.
import { initReactHook } from '../src/hook.js';
initReactHook();
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
