//go:build linux || darwin

package api

import "syscall"

// diskUsage is the size and use of the filesystem holding path.
func diskUsage(path string) *Usage {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return nil
	}
	bs := int64(st.Bsize)
	total := int64(st.Blocks) * bs
	free := int64(st.Bavail) * bs // what non-root processes can still use
	return &Usage{Total: total, Used: total - free}
}
