import { configureStore } from '@reduxjs/toolkit';

import { libraryArtifactListener } from './libraryArtifactListener';
import agentReducer from './slices/agentSlice';
import artifactReducer from './slices/artifactSlice';
import coworkReducer from './slices/coworkSlice';
import imReducer from './slices/imSlice';
import kitReducer from './slices/kitSlice';
import mcpReducer from './slices/mcpSlice';
import modelReducer from './slices/modelSlice';
import quickActionReducer from './slices/quickActionSlice';
import scheduledTaskReducer from './slices/scheduledTaskSlice';
import skillReducer from './slices/skillSlice';

export const store = configureStore({
  reducer: {
    model: modelReducer,
    cowork: coworkReducer,
    skill: skillReducer,
    mcp: mcpReducer,
    im: imReducer,
    quickAction: quickActionReducer,
    scheduledTask: scheduledTaskReducer,
    agent: agentReducer,
    artifact: artifactReducer,
    kit: kitReducer,
  },
  middleware: getDefaultMiddleware => (
    getDefaultMiddleware().prepend(libraryArtifactListener.middleware)
  ),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch; 
