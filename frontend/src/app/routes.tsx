import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';
import { RequireRole } from '../components/RequireRole';
import { AppLayout } from './AppLayout';

const LandingPage = lazy(() => import('../pages/LandingPage'));
const NotFoundPage = lazy(() => import('../pages/NotFoundPage'));
const LoginPage = lazy(() => import('../features/auth/LoginPage'));
const RegisterPage = lazy(() => import('../features/auth/RegisterPage'));
const DoctorDirectoryPage = lazy(() => import('../features/doctors/DoctorDirectoryPage'));
const CareAssistantPage = lazy(() => import('../features/ai/CareAssistantPage'));
const AskCarePulsePage = lazy(() => import('../features/knowledge/AskCarePulsePage'));
const TestGuidePage = lazy(() => import('../features/testing/TestGuidePage'));
const KnowledgeAdminPage = lazy(() => import('../features/knowledge/KnowledgeAdminPage'));
const DoctorDetailPage = lazy(() => import('../features/doctors/DoctorDetailPage'));
const PatientChartPage = lazy(() => import('../features/doctors/PatientChartPage'));
const DoctorAppointmentPage = lazy(() => import('../features/appointments/DoctorAppointmentPage'));
const ConsultationPage = lazy(() => import('../features/consultations/ConsultationPage'));
const VisitsPage = lazy(() => import('../features/patient/VisitsPage'));
const DoctorPrescriptionPage = lazy(() => import('../features/prescriptions/PrescriptionPages').then((m) => ({ default: m.DoctorPrescriptionPage })));
const PrescriptionPreviewPage = lazy(() => import('../features/prescriptions/PrescriptionPages').then((m) => ({ default: m.PrescriptionPreviewPage })));
const PatientPrescriptionsPage = lazy(() => import('../features/prescriptions/PrescriptionPages').then((m) => ({ default: m.PatientPrescriptionsPage })));
const PatientPrescriptionDetailPage = lazy(() => import('../features/prescriptions/PrescriptionPages').then((m) => ({ default: m.PatientPrescriptionDetailPage })));
const AppointmentsPage = lazy(() => import('../features/appointments/AppointmentsPage'));
const ProfilePage = lazy(() => import('../features/patient/ProfilePage'));
const HealthPage = lazy(() => import('../features/patient/HealthPage'));
const PatientDashboard = lazy(() => import('../features/dashboards/dashboards').then((m) => ({ default: m.PatientDashboard })));
const DoctorDashboard = lazy(() => import('../features/dashboards/dashboards').then((m) => ({ default: m.DoctorDashboard })));
const PharmacistDashboard = lazy(() => import('../features/dashboards/dashboards').then((m) => ({ default: m.PharmacistDashboard })));
const AdminDashboard = lazy(() => import('../features/dashboards/dashboards').then((m) => ({ default: m.AdminDashboard })));
const CataloguePage = lazy(() => import('../features/catalogue/CataloguePage'));
const AdminCatalogue = lazy(() => import('../features/admin/AdminCatalogue'));
const PharmacyQueuePage = lazy(() => import('../features/pharmacy/PharmacyPages').then((m) => ({ default: m.PharmacyQueuePage })));
const MedicineDetailPage = lazy(() => import('../features/commerce/MedicineDetailPage').then((m) => ({ default: m.MedicineDetailPage })));
const CartPage = lazy(() => import('../features/commerce/CartPage').then((m) => ({ default: m.CartPage })));
const CheckoutPage = lazy(() => import('../features/commerce/CheckoutPage').then((m) => ({ default: m.CheckoutPage })));
const OrdersPage = lazy(() => import('../features/commerce/OrdersPage').then((m) => ({ default: m.OrdersPage })));
const OrderDetailPage = lazy(() => import('../features/commerce/OrderDetailPage').then((m) => ({ default: m.OrderDetailPage })));
const PharmacyOrdersPage = lazy(() => import('../features/pharmacy/PharmacyOrdersPage').then((m) => ({ default: m.PharmacyOrdersPage })));
const PharmacyOrderPage = lazy(() => import('../features/pharmacy/PharmacyOrdersPage').then((m) => ({ default: m.PharmacyOrderPage })));
const PharmacyFulfilmentPage = lazy(() => import('../features/pharmacy/PharmacyPages').then((m) => ({ default: m.PharmacyFulfilmentPage })));
const PrescriptionReviewPage = lazy(() => import('../features/pharmacy/PrescriptionReviewPage').then((m) => ({ default: m.PrescriptionReviewPage })));
const PharmacyStockPage = lazy(() => import('../features/pharmacy/PharmacyPages').then((m) => ({ default: m.PharmacyStockPage })));

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
      { path: '/care-assistant', element: <RequireRole roles={['PATIENT']}><CareAssistantPage /></RequireRole> },
      { path: '/doctors/:doctorId', element: <RequireRole roles={['PATIENT']}><DoctorDetailPage /></RequireRole> },
      { path: '/appointments', element: <RequireRole roles={['PATIENT']}><AppointmentsPage /></RequireRole> },
      { path: '/doctor/dashboard', element: <RequireRole roles={['DOCTOR']}><DoctorDashboard /></RequireRole> },
      { path: '/doctor/patients/:patientId', element: <RequireRole roles={['DOCTOR']}><PatientChartPage /></RequireRole> },
      { path: '/doctor/appointments/:appointmentId', element: <RequireRole roles={['DOCTOR']}><DoctorAppointmentPage /></RequireRole> },
      { path: '/doctor/consultations/:consultationId', element: <RequireRole roles={['DOCTOR']}><ConsultationPage /></RequireRole> },
      { path: '/patient/visits', element: <RequireRole roles={['PATIENT']}><VisitsPage /></RequireRole> },
      { path: '/patient/prescriptions', element: <RequireRole roles={['PATIENT']}><PatientPrescriptionsPage /></RequireRole> },
      { path: '/patient/prescriptions/:prescriptionId', element: <RequireRole roles={['PATIENT']}><PatientPrescriptionDetailPage /></RequireRole> },
      { path: '/doctor/prescriptions/:prescriptionId', element: <RequireRole roles={['DOCTOR']}><DoctorPrescriptionPage /></RequireRole> },
      { path: '/doctor/prescriptions/:prescriptionId/preview', element: <RequireRole roles={['DOCTOR']}><PrescriptionPreviewPage /></RequireRole> },
      { path: '/medicines', element: <CataloguePage /> },
      { path: '/pharmacy/dashboard', element: <RequireRole roles={['PHARMACIST']}><PharmacistDashboard /></RequireRole> },
      { path: '/pharmacy/queue', element: <RequireRole roles={['PHARMACIST']}><PharmacyQueuePage /></RequireRole> },
      { path: '/medicines/:medicineId', element: <MedicineDetailPage /> },
      { path: '/cart', element: <RequireRole roles={['PATIENT']}><CartPage /></RequireRole> },
      { path: '/checkout', element: <RequireRole roles={['PATIENT']}><CheckoutPage /></RequireRole> },
      { path: '/orders', element: <RequireRole roles={['PATIENT']}><OrdersPage /></RequireRole> },
      { path: '/orders/:orderId', element: <RequireRole roles={['PATIENT']}><OrderDetailPage /></RequireRole> },
      { path: '/pharmacy/orders', element: <RequireRole roles={['PHARMACIST']}><PharmacyOrdersPage /></RequireRole> },
      { path: '/pharmacy/orders/:orderId', element: <RequireRole roles={['PHARMACIST']}><PharmacyOrderPage /></RequireRole> },
      { path: '/pharmacy/prescriptions/:prescriptionId', element: <RequireRole roles={['PHARMACIST']}><PrescriptionReviewPage /></RequireRole> },
      { path: '/pharmacy/fulfilments/:fulfilmentId', element: <RequireRole roles={['PHARMACIST']}><PharmacyFulfilmentPage /></RequireRole> },
      { path: '/pharmacy/stock', element: <RequireRole roles={['PHARMACIST']}><PharmacyStockPage /></RequireRole> },
      { path: '/admin/dashboard', element: <RequireRole roles={['ADMIN']}><AdminDashboard /></RequireRole> },
      { path: '/admin/medicines', element: <RequireRole roles={['ADMIN']}><AdminCatalogue /></RequireRole> },
      { path: '/ask', element: <RequireRole roles={['PATIENT', 'DOCTOR', 'PHARMACIST', 'ADMIN']}><AskCarePulsePage /></RequireRole> },
      { path: '/admin/knowledge', element: <RequireRole roles={['ADMIN']}><KnowledgeAdminPage /></RequireRole> },
      { path: '/test-guide', element: <RequireRole roles={['PATIENT', 'DOCTOR', 'PHARMACIST', 'ADMIN']}><TestGuidePage /></RequireRole> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
