import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import { RequireRole } from '../components/RequireRole';
import { AppLayout } from './AppLayout';

const LandingPage = lazy(() => import('../pages/LandingPage'));
const NotFoundPage = lazy(() => import('../pages/NotFoundPage'));
const LoginPage = lazy(() => import('../features/auth/LoginPage'));
const RegisterPage = lazy(() => import('../features/auth/RegisterPage'));
const PatientDashboard = lazy(() => import('../features/dashboards/dashboards').then((m) => ({ default: m.PatientDashboard })));
const DoctorDashboard = lazy(() => import('../features/dashboards/dashboards').then((m) => ({ default: m.DoctorDashboard })));
const PharmacistDashboard = lazy(() => import('../features/dashboards/dashboards').then((m) => ({ default: m.PharmacistDashboard })));
const AdminDashboard = lazy(() => import('../features/dashboards/dashboards').then((m) => ({ default: m.AdminDashboard })));

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/patient/dashboard', element: <RequireRole roles={['PATIENT']}><PatientDashboard /></RequireRole> },
      { path: '/doctor/dashboard', element: <RequireRole roles={['DOCTOR']}><DoctorDashboard /></RequireRole> },
      { path: '/pharmacy/dashboard', element: <RequireRole roles={['PHARMACIST']}><PharmacistDashboard /></RequireRole> },
      { path: '/admin/dashboard', element: <RequireRole roles={['ADMIN']}><AdminDashboard /></RequireRole> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
