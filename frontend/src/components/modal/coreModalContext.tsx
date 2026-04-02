import React, { createContext, useState } from 'react';

interface IModal {
  modalProtest?: boolean;
  modalUploadDocument?: boolean;

  title?: string;

  modal?: string;
  modal_path?: string;
  modal_id?: string;
  data?: {
    id?: number;
  };
  withQR?: boolean;
}

type ModalContextValue = [IModal, React.Dispatch<React.SetStateAction<IModal>>];

const CoreModalContext = createContext<ModalContextValue>([{}, () => {}]);

const ModalProvider = ({ children }) => {
  const [state, setState] = useState<IModal>({} as IModal);

  return (
    <CoreModalContext.Provider value={[state, setState]}>
      {children}
    </CoreModalContext.Provider>
  );
};

export { CoreModalContext, ModalProvider };
