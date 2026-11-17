import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import { RequireRole } from '../components/RequireRole';
import { AppLayout } from './AppLayout';

const LandingPage = lazy(() => import('../pages/LandingPage'));
const NotFoundPage = lazy(() => import('../pages/NotFoundPage'));
const LoginPage = lazy(() => import('../features/auth/LoginPage'));
const RegisterPage = lazy(() => import('../features/auth/RegisterPage'));
const DoctorDirectoryPage = lazy(() => import('../features/doctors/DoctorDirectoryPage'));
const DoctorDetailPage = lazy(() => import('../features/doctors/DoctorDetailPage'));
const PatientContextPage = lazy(() => import('../features/doctors/PatientContextPage'));
const AppointmentsPage = lazy(() => import('../features/appointments/AppointmentsPage'));
const ProfilePage = lazy(() => import('../features/patient/ProfilePage'));
const HealthPage = lazy(() => import('../features/patient/HealthPage'));
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
      { path: '/patient/profile', element: <RequireRole roles={['PATIENT']}><ProfilePage /></RequireRole> },
      { path: '/patient/health', element: <RequireRole roles={['PATIENT']}><HealthPage /></RequireRole> },
      { path: '/doctors', element: <RequireRole roles={['PATIENT']}><DoctorDirectoryPage /></RequireRole> },
      { path: '/doctors/:doctorId', element: <RequireRole roles={['PATIENT']}><DoctorDetailPage /></RequireRole> },
      { path: '/appointments', element: <RequireRole roles={['PATIENT']}><AppointmentsPage /></RequireRole> },
      { path: '/doctor/dashboard', element: <RequireRole roles={['DOCTOR']}><DoctorDashboard /></RequireRole> },
      { path: '/doctor/patients/:patientId', element: <RequireRole roles={['DOCTOR']}><PatientContextPage /></RequireRole> },
      { path: '/pharmacy/dashboard', element: <RequireRole roles={['PHARMACIST']}><PharmacistDashboard /></RequireRole> },
      { path: '/admin/dashboard', element: <RequireRole roles={['ADMIN']}><AdminDashboard /></RequireRole> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
