import React from 'react';
import { Route, Routes } from 'react-router';

const Navbar = React.lazy(() => import('./components/navbar/Navbar'));
const LoginForm = React.lazy(() => import('./components/auth/LoginForm'));
const LandingPage = React.lazy(() => import('./main/LandingPage'));
const TokenTransit = React.lazy(() => import('./main/TokenTransit'));
const BackupView = React.lazy(() => import('./main/BackupView'));
const TokenLogin = React.lazy(() => import('./main/TokenLogin'));
const ChangeLogs = React.lazy(() => import('./main/ChangeLogs'));
const DevView = React.lazy(() => import('./main/DevView'));

const CoreRoutes = () => {
  return (
    <Routes>
      <Route path={`/login`} element={<LoginForm />} />

      <Route path="/dev" element={<DevView />} />

      <Route path="*" element={<Navbar act={''} content={<LandingPage />} />} />
    </Routes>
  );
};
export default CoreRoutes;
